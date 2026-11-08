/**
 * The admin service, as a browser and a passkey use it: a software authenticator answers its ceremonies, and each test
 * is a request the service must refuse or a flow it must allow. Martin's sign-in path is held to the plan's list:
 *
 * - every write route refuses no session, an expired one, a revoked one, the wrong origin and a missing token;
 * - enrolment refuses no code, a used one, an expired one and a sixth try;
 * - the cookie's flags, and a new id at sign-in;
 * - a challenge cannot be used twice, and an assertion with the wrong origin, the wrong relying party or no user
 *   verification is refused;
 * - step-up is enforced on every action the table marks, and on a save of the settings that raises anything;
 * - signing out, revoking and expiry close an open full-event stream;
 * - forwarded headers from anywhere but the proxy are ignored.
 */
import type { AddressInfo } from 'node:net';
import {
  ATTACKS,
  MARTIN_ANSWER_CHARS,
  type NewEvent,
  type PayloadOf,
  upcast,
  VERSIONS,
} from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem, readPublic } from '@software-factory/store';
import { pino } from 'pino';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { PASSWORDS } from '../../../../packages/store/test/postgres.ts';
import {
  ACCESS,
  type Access,
  ENROLMENT_CODE,
  GUARDRAIL_HOLDS,
  type Name,
  routeOf,
  SESSION,
  STEP_UP,
} from '../../../../policy/access.ts';
import { ATTACK_RULES, attackAvailable } from '../../../../policy/attacks.ts';
import { flagsSpec, readFlags } from '../../../../policy/flags.ts';
import { CONTENT_SECURITY_POLICY, COOKIE } from '../../src/admin/app.ts';
import { lastLaunch } from '../../src/admin/attacks.ts';
import type { AdminConfig } from '../../src/admin/config.ts';
import { proxies } from '../../src/admin/config.ts';
import { described, enrol } from '../../src/admin/enrol.ts';
import { nextRevision } from '../../src/admin/flags.ts';
import { FlagsHeld } from '../../src/admin/flags-held.ts';
import { refuseWrite } from '../../src/admin/guard.ts';
import { NO_ROLLOUT, NO_STABLE, NOT_ABORTED } from '../../src/admin/line.ts';
import { STILL_PAUSED } from '../../src/admin/rollout.ts';
import { sha256, tokenOf } from '../../src/admin/secrets.ts';
import { type AdminService, startAdmin } from '../../src/admin/service.ts';
import type { Session } from '../../src/admin/store.ts';
import { appendMartins } from '../../src/admin/store.ts';
import { fold, type LineEvent } from '../../src/line/machine.ts';
import { KubeError, type KubeWriter } from '../../src/runners/kube.ts';
import { settingsNow } from '../../src/settings.ts';
import { CANARY, commitOf, digestOf, type RolloutState, releaseOf, rollout, STABLE } from '../release/fixtures.ts';
import { appendSettings, settingsPayload } from '../settings-events.ts';
import { Authenticator, type Ceremony } from './authenticator.ts';

const ORIGIN = 'https://console.localhost:8443';
const RP_ID = 'console.localhost';

let db: Database;
let service: AdminService;
let base: string;

/** A connection as a role, to this file's database. */
const as = (username: string, password: string): Sql => {
  const url = new URL(inject('databaseUrl'));
  return postgres({
    host: url.hostname,
    port: Number(url.port),
    database: db.name,
    username,
    password,
    max: 4,
    onnotice: () => {},
  });
};

/**
 * Starts the service; by default with no check of the flags the app holds, which would read `kube` meanwhile. It listens
 * on 127.0.0.1, the address the tests ask, so that no other program listening on its port there can answer for it.
 */
const start = async (config: Partial<AdminConfig> = {}, kube?: KubeWriter, held: FlagsHeld | false = false) => {
  service = await startAdmin(
    { origin: ORIGIN, rpId: RP_ID, trusted: proxies(''), port: 0, profile: 'local', ...config },
    {
      sql: as('factory_admin', PASSWORDS.admin),
      port: 0,
      host: '127.0.0.1',
      recheckMs: 100,
      held,
      ...(kube && { kube }),
    },
  );
  base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  db = await freshDatabase('admin');
});
afterAll(() => db?.end());

beforeEach(async () => {
  // Each test starts with no passkeys held, and so no session live: a passkey revoked ends its sessions.
  await db.owner`update passkeys set revoked_at = now() where revoked_at is null`;
  await start();
});
afterEach(() => service?.stop());

type Body = Record<string, unknown>;

/** A browser on the console's page: its session cookie and the token its writes carry. */
class Browser {
  cookie: string | undefined;
  token: string | undefined;
  /** The last `set-cookie` the service sent, as it sent it. */
  setCookie: string | undefined;

  async post(
    path: string,
    body: Body = {},
    { origin = ORIGIN, token = this.token, headers = {} as Record<string, string> } = {},
  ): Promise<{ status: number; body: Body }> {
    return this.#send(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin && { origin }),
        ...(token && { 'x-csrf-token': token }),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Body }> {
    return this.#send(path, { headers });
  }

  async #send(path: string, init: RequestInit): Promise<{ status: number; body: Body }> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        ...(this.cookie && { cookie: `${COOKIE}=${this.cookie}` }),
      },
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      this.setCookie = set;
      const value = /^__Host-session=([^;]*)/.exec(set)?.[1];
      this.cookie = value || undefined;
      if (!value) this.token = undefined;
    }
    const body = (await res.json()) as Body;
    if (typeof body.token === 'string') this.token = body.token;
    return { status: res.status, body };
  }
}

/** A code from `factory admin enrol`, as the enrolment's own role makes it. */
const newCode = async () => (await enrol(db.enrol)).code;

/** Enrols a passkey with a code, as the enrolment page does, signing the browser in. */
async function enrolWith(browser: Browser, passkey: Authenticator, code: string, ceremony: Ceremony = {}) {
  const options = await browser.post('/admin/enrol/options', { code });
  if (options.status !== 200) return options;
  return browser.post('/admin/enrol', {
    response: passkey.create(options.body as { challenge: string }, ceremony),
    name: 'Laptop',
  });
}

/** A browser signed in with a new passkey, and the passkey. */
async function signedIn(): Promise<{ browser: Browser; passkey: Authenticator }> {
  const browser = new Browser();
  const passkey = new Authenticator(ORIGIN, RP_ID);
  const enrolled = await enrolWith(browser, passkey, await newCode());
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
  return { browser, passkey };
}

async function signIn(browser: Browser, passkey: Authenticator, ceremony: Ceremony = {}) {
  const options = await browser.post('/admin/sign-in/options');
  expect(options.status).toBe(200);
  return browser.post('/admin/sign-in', { response: passkey.get(options.body as { challenge: string }, ceremony) });
}

async function stepUp(browser: Browser, passkey: Authenticator) {
  const options = await browser.post('/admin/step-up/options');
  expect(options.status).toBe(200);
  return browser.post('/admin/step-up', { response: passkey.get(options.body as { challenge: string }) });
}

const sessionOf = (browser: Browser) => sha256(browser.cookie ?? '');

/** Ends a session's hour, as the store's clock would. */
const expire = (browser: Browser) => db.owner`
  update sessions set signed_in_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute'
  where id_sha256 = ${sessionOf(browser)}`;

const lastEvents = (n: number) => db.owner<
  { type: string; actor: string; summary: string; payload: Body; public: Body }[]
>`
  select type, actor, summary, payload, public from events order by seq desc limit ${n}`;

describe('the admin service’s routes', () => {
  it('are those the access table gives it, each answered, and nothing else', async () => {
    const browser = new Browser();
    for (const [name, access] of Object.entries(ACCESS) as [Name, Access][]) {
      if (access.server !== 'admin') continue;
      for (const route of access.routes ?? []) {
        const [method = '', path = ''] = route.split(' ');
        const res = await fetch(`${base}${path.replace(':id', 'x'.repeat(20))}`, {
          method: String(method),
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          ...(method === 'POST' && { body: '{}' }),
        });
        await res.body?.cancel();
        expect(res.status, `${name}: ${route}`).not.toBe(404);
      }
    }
    for (const [method, path] of [
      ['GET', '/admin/'],
      ['GET', '/admin/sign-in'],
      ['GET', '/admin/sign-out'],
      ['PUT', '/admin/sign-out'],
      ['DELETE', '/admin/passkeys/x/revoke'],
      ['POST', '/admin/session'],
      ['GET', '/health'],
      ['GET', '/'],
      ['GET', '/admin/hold/1/approve'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: { origin: ORIGIN } });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await browser.get('/admin/health')).body).toEqual({ status: 'ok' });
  });

  it('send a strict policy, HSTS and no-store with every response, refusals and 404s included', async () => {
    for (const [method, path] of [
      ['GET', '/admin/health'],
      ['GET', '/admin/session'],
      ['POST', '/admin/sign-out'],
      ['GET', '/nowhere'],
    ]) {
      const res = await fetch(`${base}${path}`, { method: String(method) });
      await res.body?.cancel();
      expect(res.headers.get('content-security-policy'), path).toBe(CONTENT_SECURITY_POLICY);
      expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
      expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
      expect(res.headers.get('strict-transport-security'), path).toBe('max-age=31536000');
      expect(res.headers.get('cache-control'), path).toBe('no-store');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });
});

describe('enrolment', () => {
  it('makes a passkey with a code, and signs in with a session cookie that is Secure, HttpOnly and SameSite=Strict', async () => {
    const browser = new Browser();
    const passkey = new Authenticator(ORIGIN, RP_ID);
    const res = await enrolWith(browser, passkey, await newCode());
    expect(res.status).toBe(200);
    expect(browser.setCookie).toBe(
      `${COOKIE}=${browser.cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION.minutes * 60}`,
    );
    expect(browser.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The store keeps the id's hash, never the id.
    expect(await db.owner`select 1 from sessions where id_sha256 = ${sessionOf(browser)}`).toHaveLength(1);
    expect(await db.owner`select 1 from sessions where id_sha256 = ${browser.cookie ?? ''}`).toHaveLength(0);
    const session = await browser.get('/admin/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ passkey: { id: passkey.credentialId, name: 'Laptop' }, steppedUp: false });
    expect(session.body.token).toBe(tokenOf(browser.cookie ?? ''));
    // No tools in this service's settings, so none for the menu.
    expect(session.body.tools).toEqual({});
    // Recorded as Martin's, his passkey's name in the full events and not in the public views.
    const [signedIn, enrolled] = await lastEvents(2);
    expect(enrolled).toMatchObject({ type: 'passkey.enrolled', actor: 'martin', payload: { passkey: 'Laptop' } });
    expect(signedIn).toMatchObject({ type: 'admin.signed-in', actor: 'martin', payload: { passkey: 'Laptop' } });
    expect(enrolled?.public).toMatchObject({ summary: 'Martin enrolled a passkey', payload: {} });
    expect(signedIn?.public).toMatchObject({ summary: 'Martin signed in with a passkey', payload: {} });
    expect(JSON.stringify([enrolled?.public, signedIn?.public])).not.toContain('Laptop');
  });

  it('refuses no code, a code that is not one, a used one and an expired one', async () => {
    const browser = new Browser();
    expect((await browser.post('/admin/enrol/options', {})).status).toBe(400);
    expect((await browser.post('/admin/enrol/options', { code: '' })).status).toBe(400);
    expect((await browser.post('/admin/enrol/options', { code: 'AAAAAA-AAAAA-AAAAA-AAAAA-AAAAA' })).body.refused).toBe(
      'code',
    );

    const used = await newCode();
    expect((await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), used)).status).toBe(200);
    const again = await new Browser().post('/admin/enrol/options', { code: used });
    expect(again).toMatchObject({ status: 403, body: { refused: 'code', left: 0 } });

    const expired = await newCode();
    await db.owner`
      update enrolment_codes set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
      where code_sha256 = ${sha256(expired.replaceAll('-', ''))}`;
    expect(await new Browser().post('/admin/enrol/options', { code: expired })).toMatchObject({
      status: 403,
      body: { refused: 'code' },
    });
  });

  it('allows five tries of a code, counted across every client, and refuses the sixth', async () => {
    const code = await newCode();
    expect(ENROLMENT_CODE.tries).toBe(5);
    // Four wrong codes from four browsers, then the right one: five tries.
    for (let i = 0; i < 4; i++) {
      const wrong = await new Browser().post('/admin/enrol/options', { code: 'ZZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' });
      // Each says how many tries the live code has left, so the page can say so.
      expect(wrong).toMatchObject({ status: 403, body: { refused: 'code', left: 4 - i } });
    }
    expect((await new Browser().post('/admin/enrol/options', { code })).status).toBe(200);
    // The sixth is refused, however right, as a code that can no longer be used.
    expect(await new Browser().post('/admin/enrol/options', { code })).toMatchObject({
      status: 403,
      body: { refused: 'code', left: 0 },
    });
  });

  it('keeps one code live, the newest, whose tries are its own', async () => {
    const older = await newCode();
    const newer = await newCode();
    // A new code replaces the one before it, which is refused as one that can no longer be used.
    expect(await new Browser().post('/admin/enrol/options', { code: older })).toMatchObject({
      status: 403,
      body: { refused: 'code', left: 4 },
    });
    // The tries a wrong code says are left are the live code's: the one just typed counted against it alone.
    expect(await new Browser().post('/admin/enrol/options', { code: 'ZZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' })).toMatchObject({
      status: 403,
      body: { refused: 'code', left: 3 },
    });
    expect((await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), newer)).status).toBe(200);
    // Used, the newest code leaves none live: the older one does not take its place.
    expect(await new Browser().post('/admin/enrol/options', { code: older })).toMatchObject({
      status: 403,
      body: { refused: 'code', left: 0 },
    });
  });

  it('refuses a ceremony begun with a code that a newer one has replaced since', async () => {
    const older = await newCode();
    const browser = new Browser();
    const options = await browser.post('/admin/enrol/options', { code: older });
    expect(options.status).toBe(200);
    await newCode();
    const response = new Authenticator(ORIGIN, RP_ID).create(options.body as { challenge: string });
    expect(await browser.post('/admin/enrol', { response, name: 'Laptop' })).toMatchObject({
      status: 403,
      body: { refused: 'code' },
    });
    expect(await db.owner`select 1 from passkeys where revoked_at is null`).toHaveLength(0);
  });

  it('counts no try for what cannot be a code, so junk cannot burn Martin’s', async () => {
    const code = await newCode();
    for (let i = 0; i < 6; i++) {
      expect((await new Browser().post('/admin/enrol/options', { code: 'not a code' })).status).toBe(400);
    }
    expect((await new Browser().post('/admin/enrol/options', { code })).status).toBe(200);
  });

  it('opens no stream for HEAD', async () => {
    const { browser } = await signedIn();
    const res = await fetch(`${base}/admin/events/stream`, {
      method: 'HEAD',
      headers: { cookie: `${COOKIE}=${browser.cookie}` },
    });
    expect(res.status).toBe(200);
    expect(service.events.open).toBe(0);
  });

  it('accepts the code with or without its dashes, in any case', async () => {
    const code = await newCode();
    const typed = code.replaceAll('-', ' ').toLowerCase();
    expect((await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), typed)).status).toBe(200);
  });

  it('checks Origin, takes JSON alone, and is the only way to add a passkey, a session or no', async () => {
    const code = await newCode();
    const browser = new Browser();
    expect((await browser.post('/admin/enrol/options', { code }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await browser.post('/admin/enrol/options', { code }, { origin: '' })).status).toBe(403);
    const form = await fetch(`${base}/admin/enrol/options`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: `code=${code}`,
    });
    await form.body?.cancel();
    expect(form.status).toBe(415);
    // Signed in, with no code, a passkey cannot be added.
    const { browser: martin } = await signedIn();
    expect((await martin.post('/admin/enrol/options', {})).status).toBe(400);
    const answer = new Authenticator(ORIGIN, RP_ID).create({ challenge: 'c'.repeat(43) });
    expect((await martin.post('/admin/enrol', { response: answer, name: 'Phone' })).body.refused).toBe('challenge');
    expect(await db.owner`select 1 from passkeys where revoked_at is null`).toHaveLength(1);
  });

  it('holds Martin to two passkeys', async () => {
    await signedIn();
    await signedIn();
    const third = await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), await newCode());
    expect(third).toMatchObject({ status: 409, body: { refused: 'passkeys' } });
  });

  it('refuses a code while two passkeys are held before trying it, so it costs none of its tries', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();
    const code = await newCode();
    // The right code, and a wrong one last, which is refused alike, and says nothing of the live code's tries.
    for (let i = 0; i < ENROLMENT_CODE.tries; i++) {
      const tried = i < ENROLMENT_CODE.tries - 1 ? code : 'ZZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
      const refusal = await new Browser().post('/admin/enrol/options', { code: tried });
      expect(refusal).toMatchObject({ status: 409, body: { refused: 'passkeys' } });
      expect(refusal.body).not.toHaveProperty('left');
    }
    expect(
      await db.owner`select tries from enrolment_codes where code_sha256 = ${sha256(code.replaceAll('-', ''))}`,
    ).toEqual([{ tries: 0 }]);
    // One revoked, the same code still has all its tries: a sixth would be refused had any been counted. The service
    // starts again first, so that its limit on requests from one address, which these tests all share, counts afresh.
    await service.stop();
    await start();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await browser.post(`/admin/passkeys/${phone.passkey.credentialId}/revoke`)).status).toBe(200);
    // A wrong code is the first try counted against it, and says so.
    expect(await new Browser().post('/admin/enrol/options', { code: 'ZZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' })).toMatchObject({
      status: 403,
      body: { refused: 'code', left: ENROLMENT_CODE.tries - 1 },
    });
    expect((await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), code)).status).toBe(200);
  });

  it('refuses a passkey made for another origin or relying party, or without user verification', async () => {
    for (const ceremony of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { verified: false }]) {
      const res = await enrolWith(new Browser(), new Authenticator(ORIGIN, RP_ID), await newCode(), ceremony);
      expect(res, JSON.stringify(ceremony)).toMatchObject({ status: 403, body: { refused: 'passkey' } });
    }
    expect(await db.owner`select 1 from passkeys where revoked_at is null`).toHaveLength(0);
  });
});

describe('signing in', () => {
  it('gives a new session id each time, ending the one it replaces', async () => {
    const { browser, passkey } = await signedIn();
    const before = browser.cookie;
    expect((await signIn(browser, passkey)).status).toBe(200);
    expect(browser.cookie).not.toBe(before);
    expect(
      await db.owner<{ ended_by: string }[]>`select ended_by from sessions where id_sha256 = ${sha256(before ?? '')}`,
    ).toEqual([{ ended_by: 'sign-out' }]);
    const old = new Browser();
    old.cookie = before;
    expect((await old.get('/admin/session')).status).toBe(401);
    expect((await browser.get('/admin/session')).status).toBe(200);
    // The session it ended is recorded as signed out, in the same transaction, as signing out records it.
    const [now, ended] = await lastEvents(2);
    expect(ended).toMatchObject({ type: 'admin.signed-out', actor: 'martin', payload: { everywhere: false } });
    expect(now?.type).toBe('admin.signed-in');
  });

  it('tells a signed-in session the deployment’s Grafana and Argo CD, and nobody else', async () => {
    await service.stop();
    const tools = { grafana: 'http://grafana.localhost:8080/', argocd: 'http://argocd.localhost:8080/' };
    await start({ tools });
    const { browser } = await signedIn();
    expect((await browser.get('/admin/session')).body.tools).toEqual(tools);
    const visitor = await new Browser().get('/admin/session');
    expect(visitor.status).toBe(401);
    expect(JSON.stringify(visitor.body)).not.toContain('localhost:8080');
  });

  it('records no sign-out for a session the browser had that had already ended', async () => {
    const { browser, passkey } = await signedIn();
    await expire(browser);
    expect((await signIn(browser, passkey)).status).toBe(200);
    const [now, before] = await lastEvents(2);
    expect(now?.type).toBe('admin.signed-in');
    expect(before?.type).not.toBe('admin.signed-out');
  });

  it('uses each challenge once', async () => {
    const { browser, passkey } = await signedIn();
    const options = await browser.post('/admin/sign-in/options');
    const answer = passkey.get(options.body as { challenge: string });
    expect((await browser.post('/admin/sign-in', { response: answer })).status).toBe(200);
    expect(await browser.post('/admin/sign-in', { response: answer })).toMatchObject({
      status: 403,
      body: { refused: 'challenge' },
    });
    // Nor one the service never made.
    const made = passkey.get({ challenge: 'd'.repeat(43) });
    expect((await browser.post('/admin/sign-in', { response: made })).body.refused).toBe('challenge');
  });

  it('refuses an assertion for another origin or relying party, or without user verification', async () => {
    const { passkey } = await signedIn();
    for (const ceremony of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { verified: false }]) {
      const res = await signIn(new Browser(), passkey, ceremony);
      expect(res, JSON.stringify(ceremony)).toMatchObject({ status: 403, body: { refused: 'passkey' } });
    }
    expect((await signIn(new Browser(), passkey)).status).toBe(200);
  });

  it('refuses a passkey it never enrolled, or one revoked, and a request from anywhere but the console', async () => {
    expect((await signIn(new Browser(), new Authenticator(ORIGIN, RP_ID))).body.refused).toBe('passkey');
    const { passkey } = await signedIn();
    expect((await new Browser().post('/admin/sign-in/options', {}, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    await enrol(db.enrol, { revokeOthers: true });
    expect((await signIn(new Browser(), passkey)).body.refused).toBe('passkey');
  });
});

/** Each write route the service serves, with a body it takes. */
const WRITES: [string, Body][] = [
  ['/admin/sign-out', {}],
  ['/admin/sign-out-everywhere', {}],
  ['/admin/step-up/options', {}],
  ['/admin/step-up', {}],
  ['/admin/step-up/end', {}],
  ['/admin/passkeys/whichever-passkey/revoke', {}],
  ['/admin/release/promote', { release: 'whichever-1' }],
  ['/admin/release/promote', { release: 'whichever-1', fully: true }],
  ['/admin/release/pause', { release: 'whichever-1' }],
  ['/admin/release/resume', { release: 'whichever-1' }],
  ['/admin/release/abort', { release: 'whichever-1' }],
  ['/admin/release/retry', { release: 'whichever-1' }],
  ['/admin/line/stop', { reason: 'Something is wrong' }],
  ['/admin/line/start', { reason: 'Fixed' }],
  ['/admin/line/controls', { newWork: true }],
  ['/admin/alerts/phone', { phone: true }],
  ['/admin/settings', { caps: { dayUsd: 10 } }],
  ['/admin/holds/1/approve', { hold: crypto.randomUUID() }],
  ['/admin/holds/1/reject', { hold: crypto.randomUUID() }],
  ['/admin/holds/1/answer', { hold: crypto.randomUUID(), words: 'Go on' }],
  ['/admin/holds/1/replan', { hold: crypto.randomUUID(), words: 'The spec is wrong' }],
  ['/admin/flags/delivery-dates/stage', { from: { stage: 'off' }, to: { stage: 'checks' } }],
  ['/admin/attacks/egress', {}],
];

describe('every write route', () => {
  it('is in the table as a write that takes a session, and refuses one by GET', async () => {
    for (const [path] of WRITES) {
      const route = routeOf('admin', 'POST', path);
      expect(route && ACCESS[route.name]).toMatchObject({ role: 'admin', does: 'write' });
      expect(routeOf('admin', 'GET', path), path).toBeNull();
    }
  });

  it('refuses no session, an expired one, a revoked one and one signed out', async () => {
    const expect401 = async (browser: Browser, why: string) => {
      for (const [path, body] of WRITES) {
        const res = await browser.post(path, body);
        expect(res, `${why}: ${path}`).toMatchObject({ status: 401, body: { refused: 'session' } });
      }
    };
    await expect401(new Browser(), 'no session');

    const expired = (await signedIn()).browser;
    await expire(expired);
    await expect401(expired, 'expired');

    const revoked = (await signedIn()).browser;
    await enrol(db.enrol, { revokeOthers: true });
    await expect401(revoked, 'revoked');

    const out = (await signedIn()).browser;
    const token = out.token;
    const cookie = out.cookie;
    expect((await out.post('/admin/sign-out')).status).toBe(200);
    out.cookie = cookie;
    out.token = token;
    await expect401(out, 'signed out');
  });

  it('refuses the wrong origin, no origin, a missing token and another session’s token', async () => {
    const { browser } = await signedIn();
    const other = (await signedIn()).browser;
    for (const [path, body] of WRITES) {
      expect((await browser.post(path, body, { origin: 'https://evil.example' })).body.refused, path).toBe('origin');
      expect((await browser.post(path, body, { origin: 'http://console.localhost:8443' })).body.refused, path).toBe(
        'origin',
      );
      expect((await browser.post(path, body, { origin: '' })).body.refused, path).toBe('origin');
      expect((await browser.post(path, body, { token: '' })).body.refused, path).toBe('token');
      expect((await browser.post(path, body, { token: other.token })).body.refused, path).toBe('token');
    }
    // Nothing was done: both are still signed in.
    expect((await browser.get('/admin/session')).status).toBe(200);
    expect((await other.get('/admin/session')).status).toBe(200);
  });
});

describe('the passkey given again', () => {
  const live = (steppedUp: boolean): Session => ({
    hash: 'h',
    passkey: { id: 'p', name: 'Laptop', transports: [] },
    signedInAt: new Date(),
    expiresAt: new Date(),
    steppedUpAt: steppedUp ? new Date() : null,
    steppedUp,
  });

  it('is needed by every action the table marks, and by none it does not', () => {
    const id = 'i'.repeat(43);
    const given = { origin: ORIGIN, token: tokenOf(id), id };
    const marked = (Object.entries(ACCESS) as [Name, Access][]).filter(([, access]) => access.stepUp);
    expect(marked.length).toBeGreaterThan(10);
    for (const [name, access] of marked) {
      expect(refuseWrite(access, given, live(false), ORIGIN)?.refused, name).toBe('step-up');
      expect(refuseWrite(access, given, live(true), ORIGIN), name).toBeUndefined();
    }
    for (const [name, access] of Object.entries(ACCESS) as [Name, Access][]) {
      if (access.stepUp || access.does !== 'write') continue;
      expect(refuseWrite(access, given, live(false), ORIGIN), name).toBeUndefined();
    }
  });

  it('is asked for by revoking a passkey, and lasts five minutes', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();
    const revoke = `/admin/passkeys/${phone.passkey.credentialId}/revoke`;
    expect(await browser.post(revoke)).toMatchObject({ status: 403, body: { refused: 'step-up' } });

    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await browser.get('/admin/session')).body.steppedUp).toBe(true);
    // Recorded as Martin's, with his passkey's name in the full event and not in the public view.
    const [stepped] = await lastEvents(1);
    expect(stepped).toMatchObject({ type: 'admin.stepped-up', actor: 'martin', payload: { passkey: 'Laptop' } });
    expect(stepped?.public).toMatchObject({ summary: 'Martin gave his passkey again', payload: {} });
    expect(JSON.stringify(stepped?.public)).not.toContain('Laptop');
    await db.owner`
      update sessions set stepped_up_at = now() - make_interval(mins => ${STEP_UP.minutes + 1})
      where id_sha256 = ${sessionOf(browser)}`;
    expect(await browser.post(revoke)).toMatchObject({ status: 403, body: { refused: 'step-up' } });

    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post(revoke)).toMatchObject({ status: 200, body: { revoked: true, signedOut: false } });
    // The phone's session ended with its passkey.
    expect((await phone.browser.get('/admin/session')).status).toBe(401);
    const [revoked] = await lastEvents(1);
    expect(revoked).toMatchObject({ type: 'passkey.revoked', payload: { passkey: 'Laptop', from: 'console' } });
    expect(revoked?.public).toMatchObject({ summary: 'Martin revoked a passkey', payload: { from: 'console' } });
    expect(JSON.stringify(revoked?.public)).not.toContain('Laptop');
  });

  it('is only the session’s own passkey, given for its own challenge', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();
    const steppedUp = () => db.owner`select 1 from events where type = 'admin.stepped-up'`;
    const recorded = (await steppedUp()).length;
    const options = await browser.post('/admin/step-up/options');
    const theirs = phone.passkey.get(options.body as { challenge: string });
    expect((await browser.post('/admin/step-up', { response: theirs })).body.refused).toBe('passkey');
    // A challenge made for the phone's session is not this one's, whatever passkey answers it.
    const phones = await phone.browser.post('/admin/step-up/options');
    const crossed = passkey.get(phones.body as { challenge: string });
    expect((await browser.post('/admin/step-up', { response: crossed })).body.refused).toBe('challenge');
    expect((await browser.get('/admin/session')).body.steppedUp).toBe(false);
    expect(await steppedUp()).toHaveLength(recorded);
  });

  it('ends early, for this session alone, with no passkey, and the next action asks for it again', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();
    const revoke = `/admin/passkeys/${phone.passkey.credentialId}/revoke`;
    const ended = () => db.owner`select 1 from events where type = 'admin.step-up-ended'`;
    const before = (await ended()).length;
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await stepUp(phone.browser, phone.passkey)).status).toBe(200);

    // A write like any other: the console's origin, a session and its token, but not the passkey again.
    expect(ACCESS['step-up.end']).toMatchObject({ role: 'admin', does: 'write', stepUp: false });
    expect(await browser.post('/admin/step-up/end', {}, { origin: 'https://evil.example' })).toMatchObject({
      status: 403,
      body: { refused: 'origin' },
    });
    expect(await browser.post('/admin/step-up/end', {}, { token: tokenOf('o'.repeat(43)) })).toMatchObject({
      status: 403,
      body: { refused: 'token' },
    });
    expect((await browser.get('/admin/session')).body.steppedUp).toBe(true);

    expect(await browser.post('/admin/step-up/end')).toMatchObject({ status: 200, body: { ended: true } });
    const session = (await browser.get('/admin/session')).body;
    expect(session).toMatchObject({ steppedUp: false, steppedUpAt: null });
    expect(await browser.post(revoke)).toMatchObject({ status: 403, body: { refused: 'step-up' } });
    // Recorded as Martin's, with nothing of his session in it.
    const [record] = await lastEvents(1);
    expect(record).toMatchObject({ type: 'admin.step-up-ended', actor: 'martin', payload: {} });
    expect(record?.public).toMatchObject({ summary: 'Martin ended his passkey’s five minutes early', payload: {} });
    // The phone's session keeps its own.
    expect((await phone.browser.get('/admin/session')).body.steppedUp).toBe(true);

    // Ended already, or run out: nothing to end, and nothing recorded.
    expect(await browser.post('/admin/step-up/end')).toMatchObject({ status: 200, body: { ended: false } });
    await db.owner`
      update sessions set stepped_up_at = now() - make_interval(mins => ${STEP_UP.minutes + 1})
      where id_sha256 = ${sessionOf(phone.browser)}`;
    expect(await phone.browser.post('/admin/step-up/end')).toMatchObject({ status: 200, body: { ended: false } });
    expect(await ended()).toHaveLength(before + 1);

    // Given again, it counts again.
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await browser.get('/admin/session')).body.steppedUp).toBe(true);
  });
});

describe('signing out', () => {
  it('ends the session on the server, and clears the cookie', async () => {
    const { browser } = await signedIn();
    const cookie = browser.cookie;
    expect(await browser.post('/admin/sign-out')).toMatchObject({ status: 200, body: { signedOut: 'here' } });
    expect(browser.setCookie).toBe(`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect(await db.owner`select ended_by from sessions where id_sha256 = ${sha256(cookie ?? '')}`).toEqual([
      { ended_by: 'sign-out' },
    ]);
    expect((await lastEvents(1))[0]).toMatchObject({ type: 'admin.signed-out', payload: { everywhere: false } });
  });

  it('everywhere ends every session', async () => {
    const laptop = await signedIn();
    const phone = await signedIn();
    expect((await laptop.browser.post('/admin/sign-out-everywhere')).body).toEqual({ signedOut: 'everywhere' });
    expect((await phone.browser.get('/admin/session')).status).toBe(401);
    expect(await db.owner`select 1 from sessions where ended_at is null`).toHaveLength(0);
    expect((await lastEvents(1))[0]).toMatchObject({ type: 'admin.signed-out', payload: { everywhere: true } });
  });
});

/** Opens the full-event stream, and reads it until it closes or `until` is seen. */
async function openStream(browser: Browser) {
  const res = await fetch(`${base}/admin/events/stream`, {
    headers: browser.cookie ? { cookie: `${COOKIE}=${browser.cookie}` } : {},
  });
  const reader = res.body?.getReader();
  let text = '';
  const read = async (until: string, ms = 5000): Promise<{ text: string; closed: boolean }> => {
    const deadline = Date.now() + ms;
    while (!text.includes(until)) {
      if (Date.now() > deadline) throw new Error(`no ${until} in ${text}`);
      const chunk = await reader?.read();
      if (!chunk || chunk.done) return { text, closed: true };
      text += new TextDecoder().decode(chunk.value);
    }
    return { text, closed: false };
  };
  const closed = async () => {
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) return text;
      text += new TextDecoder().decode(chunk.value);
    }
  };
  return { res, read, closed, cancel: () => reader?.cancel() };
}

describe('the full-event stream', () => {
  it('sends a signed-in session the full events, and nobody else anything', async () => {
    expect((await openStream(new Browser())).res.status).toBe(401);
    const { browser } = await signedIn();
    const stream = await openStream(browser);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('cache-control')).toBe('no-store, no-transform');
    // The full events: the passkey's name, which no public view carries.
    const { text } = await stream.read('"passkey":"Laptop"');
    expect(text).toContain('"type":"admin.signed-in"');
    await stream.cancel();
  });

  it('closes when the session signs out, everywhere, or its passkey is revoked', async () => {
    const { browser, passkey } = await signedIn();
    const phone = await signedIn();

    const mine = await openStream(browser);
    await mine.read('admin.signed-in');
    await browser.post('/admin/sign-out');
    expect(await mine.closed()).toContain('event: ended\ndata: {"why":"signed-out"}');

    expect((await signIn(browser, passkey)).status).toBe(200);
    const theirs = await openStream(phone.browser);
    await theirs.read('admin.signed-in');
    expect((await stepUp(browser, passkey)).status).toBe(200);
    await browser.post(`/admin/passkeys/${phone.passkey.credentialId}/revoke`);
    expect(await theirs.closed()).toContain('"why":"revoked"');

    const again = await openStream(browser);
    await again.read('admin.signed-in');
    await browser.post('/admin/sign-out-everywhere');
    expect(await again.closed()).toContain('"why":"signed-out"');
    expect(service.events.open).toBe(0);
  });

  it('closes when the session expires, or the command line revokes it, at its next check', async () => {
    const first = await signedIn();
    const stream = await openStream(first.browser);
    await stream.read('admin.signed-in');
    await expire(first.browser);
    expect(await stream.closed()).toContain('"why":"ended"');

    const second = await signedIn();
    const other = await openStream(second.browser);
    await other.read('admin.signed-in');
    await enrol(db.enrol, { revokeOthers: true });
    expect(await other.closed()).toContain('"why":"ended"');
  });
});

describe('a command a role not Martin’s appended', () => {
  const event = (type: 'work-item.opened' | 'hold.answered' | 'line.started', payload: object): NewEvent =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: type === 'line.started' ? null : '4100',
      type,
      version: VERSIONS[type],
      actor: type === 'work-item.opened' ? 'probe' : 'martin',
      summary: `${type}, as Martin`,
      payload,
      artifacts: [],
    }) as NewEvent;
  const writer = (sql: Sql) => new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });

  it('is in neither the full stream nor the public one', async () => {
    await writer(db.operator).append(
      event('work-item.opened', { kind: 'defect-fix', title: 'A defect', sample: false, category: 'functional' }),
    );
    // Row security refuses it from a worker's role; were that guard to fail, the readers would still leave it out.
    const forged = event('hold.answered', { decision: 'approved' });
    await db.owner`alter table events disable row level security`;
    try {
      await writer(db.as.line).append(forged);
    } finally {
      await db.owner`alter table events enable row level security`;
    }
    expect(await db.owner`select 1 from events where id = ${forged.id}`).toHaveLength(1);
    const genuine = event('line.started', { autonomy: 'supervised' });
    await writer(db.operator).append(genuine);

    const { browser } = await signedIn();
    const stream = await openStream(browser);
    const { text } = await stream.read(genuine.id);
    await stream.cancel();
    expect(text).not.toContain(forged.id);

    const read = (await readPublic(db.reader, 0)).map(({ event }) => (event as { id?: string }).id);
    expect(read).toContain(genuine.id);
    expect(read).not.toContain(forged.id);
  });
});

/**
 * The app's Rollout, as Kubernetes keeps it for the admin service: read, and merge-patched, each patch conditional on
 * the `resourceVersion` it names, as the API server makes it.
 */
type StablePod = 'ready' | 'unready' | 'terminating' | 'gone' | 'unreachable' | 'unserved';

class RolloutKube implements KubeWriter {
  object: Record<string, unknown>;
  version = 1;
  readonly patches: { path: string; body: Record<string, unknown> }[] = [];
  /**
   * Answers the next patches with these statuses, in turn, as the API server would, or makes one and loses its answer
   * (`lost`), or makes one and answers with a server error (`made-504`).
   */
  readonly failing: (number | 'lost' | 'made-504' | undefined)[] = [];
  /**
   * Whether the Rollout is written back as Argo Rollouts' Go types write it, each flag that is false left out
   * (`omitempty`), so a patch that sets one false leaves it absent.
   */
  dropsFalse = false;
  /** Whether a patch that fails leaves the API out of reach for the next read too. */
  unreadableAfter = false;
  #unreadable = false;
  /** What the controller does to the Rollout as soon as a patch is made, before anyone reads it again. */
  controller: ((object: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /**
   * The stable version's pods among the app's endpoints: one ready (`ready`), one not ready yet, one shutting down, none
   * (`gone`, the canary's alone), or no answer (`unreachable`); a list says each read's in turn, the last again after
   * that. The canary's pod is always there, and ready.
   */
  stablePod: StablePod | StablePod[] = 'ready';
  /** The paths of the EndpointSlices read, a read each. */
  readonly slices: string[] = [];

  constructor(state: RolloutState, paused = false) {
    const r = rollout(state);
    this.object = { ...r, spec: { ...r.spec, paused } };
  }

  async get<T>(path: string, schema: { parse(v: unknown): T }): Promise<T | undefined> {
    if (path.includes('/endpointslices')) {
      this.slices.push(path);
      const pod = Array.isArray(this.stablePod)
        ? ((this.stablePod.length > 1 ? this.stablePod.shift() : this.stablePod[0]) ?? 'ready')
        : this.stablePod;
      if (pod === 'unreachable') throw new KubeError(403, `GET ${path} answered 403`);
      if (pod === 'unserved') return undefined;
      const endpoint = (hash: string, conditions: object) => ({
        addresses: ['10.42.0.9'],
        conditions,
        targetRef: { kind: 'Pod', name: `website-${hash}-x7k2p` },
      });
      const status = (this.object.status ?? {}) as { stableRS?: string; currentPodHash?: string };
      const endpoints = [endpoint(status.currentPodHash ?? '', { ready: true })];
      if (pod !== 'gone') {
        endpoints.push(
          endpoint(status.stableRS ?? '', {
            ready: pod === 'ready',
            ...(pod === 'terminating' && { terminating: true }),
          }),
        );
      }
      return schema.parse({ items: [{ addressType: 'IPv4', endpoints }] });
    }
    if (this.#unreadable) {
      this.#unreadable = false;
      throw new Error('connect ECONNREFUSED');
    }
    const object = this.object as { metadata: object };
    return schema.parse({ ...object, metadata: { ...object.metadata, resourceVersion: String(this.version) } });
  }

  async patch(path: string, body: unknown): Promise<void> {
    const failing = this.failing.shift();
    if (typeof failing === 'number') {
      this.#unreadable = this.unreadableAfter;
      throw new KubeError(failing, `PATCH ${path} answered ${failing}`);
    }
    const { metadata, ...rest } = body as { metadata?: { resourceVersion?: string } };
    if (metadata?.resourceVersion && metadata.resourceVersion !== String(this.version)) {
      throw new KubeError(409, 'the object has been modified');
    }
    this.patches.push({ path, body: rest });
    this.object = merged(this.object, rest) as Record<string, unknown>;
    if (this.dropsFalse) this.object = withoutFalse(this.object);
    if (this.controller) this.object = this.controller(this.object);
    this.version += 1;
    // Made, and its answer lost on the way back.
    if (failing === 'lost') throw new Error('socket hang up');
    if (failing === 'made-504') throw new KubeError(504, `PATCH ${path} answered 504`);
  }

  text = async () => undefined;
  create = async () => {};
  remove = async () => {};
  replace = async () => {};
}

/** The Rollout's spec and status with each flag that is false left out, as `omitempty` leaves it out. */
function withoutFalse(object: Record<string, unknown>): Record<string, unknown> {
  const drop = (part: unknown) =>
    Object.fromEntries(Object.entries((part ?? {}) as object).filter(([, value]) => value !== false));
  return { ...object, spec: drop(object.spec), status: drop(object.status) };
}

/** A JSON merge patch (RFC 7386). */
function merged(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as object) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = merged(out[key], value);
  }
  return out;
}

describe('the release controls', () => {
  const ROLLOUT = { namespace: 'website', name: 'website' };
  const at = (n: number) => new Date(Date.now() - n * 1000).toISOString();
  // Events are append-only, so each test's release is a release of its own: the canary at a revision of its own.
  let revision = 20;
  let RELEASE = releaseOf(CANARY, revision);

  /** Appends events as a role, as the line or Martin's command line would. */
  const append = (sql: Sql, events: { type: string; payload: object; actor?: string }[]) =>
    sql.begin((tx) =>
      appendMartins(
        sql,
        tx,
        events.map(({ type, payload, actor = 'rollouts' }) => ({
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          work_item: null,
          type,
          version: VERSIONS[type as keyof typeof VERSIONS],
          actor,
          summary: `${type} for the test`,
          payload,
          artifacts: [],
        })) as NewEvent[],
      ),
    );

  const started = () => ({
    type: 'release.started',
    payload: {
      release: RELEASE,
      version: commitOf(CANARY),
      previous: commitOf(STABLE),
      image: { digest: digestOf(CANARY), signed: true, admitted: true },
      watched: true,
      steps: null,
      dryRun: false,
    },
  });
  const ended = (type: 'release.aborted' | 'release.rolled-back') => ({
    type,
    payload:
      type === 'release.aborted'
        ? { release: RELEASE, version: commitOf(CANARY), restored: commitOf(STABLE), abortedAt: at(30), by: 'stop' }
        : {
            release: RELEASE,
            version: commitOf(CANARY),
            restored: commitOf(STABLE),
            weight: 25,
            reason: 'Metric "errors" assessed Failed',
            failed: [],
            dryRun: false,
            by: 'analysis',
            abortedAt: at(30),
          },
  });

  /**
   * The service, with the app's Rollout in this state, at a revision of its own, and the line's record of its release:
   * its start, then each end given, or nothing.
   */
  const withRollout = async (
    state: Omit<RolloutState, 'revision'>,
    {
      paused = false,
      ends = [],
      recorded = true,
    }: { paused?: boolean; ends?: Parameters<typeof ended>[0][]; recorded?: boolean } = {},
  ) => {
    revision += 1;
    RELEASE = releaseOf(CANARY, revision);
    if (recorded) await append(db.as.line, [started(), ...ends.map(ended)]);
    const kube = new RolloutKube({ ...state, revision }, paused);
    await service.stop();
    await start({ rollout: ROLLOUT }, kube);
    return kube;
  };

  const controls = async () =>
    db.owner<{ actor: string; appended_by: string; summary: string; payload: Body; public: Body }[]>`
      select actor, appended_by, summary, payload, public from events where type = 'release.controlled'
      order by seq`;

  it('pauses, resumes and aborts, each recorded as Martin’s, with nothing of his session in the public view', async () => {
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    const { browser } = await signedIn();
    const before = (await controls()).length;
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({
      status: 200,
      body: { action: 'pause', release: RELEASE, weight: 25 },
    });
    expect(await browser.post('/admin/release/resume', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(await browser.post('/admin/release/abort', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(kube.patches).toEqual([
      { path: '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website', body: { spec: { paused: true } } },
      { path: '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website', body: { spec: { paused: false } } },
      {
        path: '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website/status',
        body: { status: { abort: true } },
      },
    ]);
    const recorded = (await controls()).slice(before);
    expect(recorded.map((c) => [c.payload.action, c.actor, c.appended_by])).toEqual([
      ['pause', 'martin', 'factory_admin'],
      ['resume', 'martin', 'factory_admin'],
      ['abort', 'martin', 'factory_admin'],
    ]);
    expect(recorded[0]).toMatchObject({
      summary: `Martin paused the canary of ${commitOf(CANARY).slice(0, 7)} at 25%`,
      payload: { release: RELEASE, version: commitOf(CANARY), weight: 25 },
    });
    expect(recorded[0]?.public).toMatchObject({ summary: recorded[0]?.summary, payload: recorded[0]?.payload });
  });

  it('asks for the passkey again to promote, to the next step’s weight or fully', async () => {
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { paused: true });
    const { browser, passkey } = await signedIn();
    for (const body of [{ release: RELEASE }, { release: RELEASE, fully: true }]) {
      expect(await browser.post('/admin/release/promote', body)).toMatchObject({
        status: 403,
        body: { refused: 'step-up' },
      });
    }
    expect(kube.patches).toEqual([]);
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/release/promote', { release: RELEASE })).toMatchObject({
      status: 200,
      body: { action: 'promote', weight: 25, to: 50 },
    });
    // Moved on to the next step that sets a weight, its pauses cleared, and resumed: it was paused.
    expect(kube.patches.map((p) => p.body)).toEqual([
      { status: { pauseConditions: null, controllerPause: false, currentStepIndex: 3 } },
      { spec: { paused: false } },
    ]);
    expect(await browser.post('/admin/release/promote', { release: RELEASE, fully: true })).toMatchObject({
      status: 200,
      body: { action: 'promote-fully', to: 100 },
    });
    expect(kube.patches.at(-1)?.body).toEqual({ status: { promoteFull: true } });
    expect((await controls()).slice(-2).map((c) => c.payload)).toEqual([
      { action: 'promote', release: RELEASE, version: commitOf(CANARY), weight: 25, to: 50 },
      { action: 'promote-fully', release: RELEASE, version: commitOf(CANARY), weight: 25, to: 100 },
    ]);
  });

  it('retries a stopped or rolled-back release with the passkey again, never while the line is stopped', async () => {
    const stopped = { current: CANARY, stable: STABLE, stepIndex: 0, abort: true };
    let kube = await withRollout(stopped, { ends: ['release.aborted'] });
    const { browser, passkey } = await signedIn();
    expect(await browser.post('/admin/release/retry', { release: RELEASE })).toMatchObject({
      status: 403,
      body: { refused: 'step-up' },
    });
    expect((await stepUp(browser, passkey)).status).toBe(200);
    await append(db.operator, [
      { type: 'line.stopped', payload: { reason: 'Martin stopped the line' }, actor: 'martin' },
    ]);
    expect(await browser.post('/admin/release/retry', { release: RELEASE })).toMatchObject({
      status: 409,
      body: { refused: 'line', message: 'Start the line first: a stopped line starts no canary.' },
    });
    await append(db.operator, [{ type: 'line.started', payload: { autonomy: 'supervised' }, actor: 'martin' }]);
    expect(await browser.post('/admin/release/retry', { release: RELEASE })).toMatchObject({
      status: 200,
      body: { action: 'retry', weight: 0 },
    });
    expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: false } }]);

    // Rolled back, by the analysis or by Martin's abort of a canary it judged bad: retried, it is judged afresh.
    kube = await withRollout(stopped, { ends: ['release.rolled-back'] });
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/release/retry', { release: RELEASE })).toMatchObject({
      status: 200,
      body: { action: 'retry', weight: 0 },
    });
    expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: false } }]);
    // In flight, there is nothing to retry.
    kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    expect(await browser.post('/admin/release/retry', { release: RELEASE })).toMatchObject({
      status: 409,
      body: { refused: 'release' },
    });
    expect(kube.patches).toEqual([]);
  });

  it('takes only Promote fully and Abort of a canary the analysis judged bad and paused for Martin', async () => {
    const held = { current: CANARY, stable: STABLE, stepIndex: 5, weight: 50, pausedFor: 'InconclusiveAnalysisRun' };
    const kube = await withRollout(held);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    for (const action of ['promote', 'pause', 'resume']) {
      expect(await browser.post(`/admin/release/${action}`, { release: RELEASE }), action).toMatchObject({
        status: 409,
        body: { refused: 'release', message: expect.stringContaining('judged the canary bad') },
      });
    }
    expect(kube.patches).toEqual([]);
    expect(await browser.post('/admin/release/abort', { release: RELEASE })).toMatchObject({
      status: 200,
      body: { action: 'abort', weight: 50 },
    });
    expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }]);
    // Promoted fully instead, past the analysis's verdict.
    const again = await withRollout(held);
    expect(await browser.post('/admin/release/promote', { release: RELEASE, fully: true })).toMatchObject({
      status: 200,
      body: { action: 'promote-fully', to: 100 },
    });
    expect(again.patches.map((p) => p.body)).toEqual([{ status: { promoteFull: true } }]);
  });

  it('refuses a release that is not the one in the Rollout, or not recorded, and a control its state does not take', async () => {
    const before = (await controls()).length;
    const first = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    const { browser } = await signedIn();
    expect(await browser.post('/admin/release/abort', { release: releaseOf(STABLE) })).toMatchObject({
      status: 409,
      body: { refused: 'release' },
    });
    expect(await browser.post('/admin/release/resume', { release: RELEASE })).toMatchObject({
      status: 409,
      body: { refused: 'release', message: 'The canary is not paused.' },
    });
    expect(await browser.post('/admin/release/abort', { release: '../x' })).toMatchObject({
      status: 400,
      body: { refused: 'body' },
    });
    const unrecorded = await withRollout(
      { current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 },
      { recorded: false },
    );
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({
      status: 409,
      body: { refused: 'release' },
    });
    expect([...first.patches, ...unrecorded.patches]).toEqual([]);
    expect(await controls()).toHaveLength(before);
  });

  it('records nothing when Kubernetes refuses the patch, and reads again when the Rollout changed meanwhile', async () => {
    const before = (await controls()).length;
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    const { browser } = await signedIn();
    kube.failing.push(422);
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({
      status: 502,
      body: { refused: 'kubernetes' },
    });
    expect(await controls()).toHaveLength(before);
    kube.failing.push(409);
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(kube.patches).toHaveLength(1);
    expect(await controls()).toHaveLength(before + 1);
    // A patch made whose answer was lost is read back, found made, and recorded.
    kube.failing.push('lost');
    expect(await browser.post('/admin/release/resume', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(await controls()).toHaveLength(before + 2);
  });

  it('answers a patch that failed as not made, and one it cannot read back as not known, recording neither', async () => {
    const before = (await controls()).length;
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    const { browser } = await signedIn();
    kube.failing.push(503);
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({
      status: 502,
      body: { refused: 'kubernetes', message: 'Kubernetes failed the change, and nothing was done.' },
    });
    // Failed, and the API out of reach for the read back after it.
    kube.failing.push(503);
    kube.unreadableAfter = true;
    const res = await browser.post('/admin/release/pause', { release: RELEASE });
    expect(res).toMatchObject({ status: 504, body: { refused: 'kubernetes' } });
    expect(res.body.message).toMatch(/can't be told/);
    expect(kube.patches).toEqual([]);
    expect(await controls()).toHaveLength(before);
  });

  it('reads a flag Argo Rollouts leaves out when false as false, when a patch’s answer was lost', async () => {
    const before = (await controls()).length;
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    let kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { paused: true });
    kube.dropsFalse = true;
    // A resume (`spec.paused`) and a promotion (`status.controllerPause`), each made and its answer lost.
    kube.failing.push('lost');
    expect(await browser.post('/admin/release/resume', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(kube.object.spec).not.toHaveProperty('paused');
    kube.failing.push('lost');
    expect(await browser.post('/admin/release/promote', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(kube.object.status).not.toHaveProperty('controllerPause');
    // One that was not made is still not made: a pause, answered with a server error, reads back as no pause.
    kube.failing.push(503);
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({
      status: 502,
      body: { refused: 'kubernetes' },
    });
    // One that was made, answered with a server error, is read back too.
    kube.failing.push('made-504');
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({ status: 200 });
    // A retry (`status.abort`), made and its answer lost: the Rollout shows no abort, which is no abort.
    kube = await withRollout(
      { current: CANARY, stable: STABLE, stepIndex: 0, abort: true },
      { ends: ['release.aborted'] },
    );
    kube.dropsFalse = true;
    kube.failing.push('lost');
    expect(await browser.post('/admin/release/retry', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(kube.object.status).not.toHaveProperty('abort');
    expect((await controls()).slice(before).map((c) => c.payload.action)).toEqual([
      'resume',
      'promote',
      'pause',
      'retry',
    ]);
  });

  it('resumes a paused canary it aborts, so no pause outlives it', async () => {
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { paused: true });
    const { browser } = await signedIn();
    expect(await browser.post('/admin/release/abort', { release: RELEASE })).toMatchObject({ status: 200 });
    expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }, { spec: { paused: false } }]);
  });

  it('reads the Rollout again and resumes once more when it changed between the abort and the resume', async () => {
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { paused: true });
    const { browser } = await signedIn();
    // The abort is made; the controller writes the status before the resume, which conflicts once.
    kube.failing.push(undefined, 409);
    const answer = await browser.post('/admin/release/abort', { release: RELEASE });
    expect(answer).toMatchObject({ status: 200, body: { action: 'abort' } });
    expect(answer.body).not.toHaveProperty('warning');
    expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }, { spec: { paused: false } }]);
    expect(kube.object.spec).toMatchObject({ paused: false });
    // A resume made and answered with a server error is read back, and found made.
    const next = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { paused: true });
    next.failing.push(undefined, 'made-504');
    const read = await browser.post('/admin/release/abort', { release: RELEASE });
    expect(read).toMatchObject({ status: 200 });
    expect(read.body).not.toHaveProperty('warning');
  });

  it('says the pause is still set when the Rollout keeps changing after the control was made', async () => {
    const before = (await controls()).length;
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { paused: true });
    const { browser } = await signedIn();
    kube.failing.push(undefined, 409, 409, 409);
    expect(await browser.post('/admin/release/abort', { release: RELEASE })).toMatchObject({
      status: 200,
      body: { action: 'abort', warning: STILL_PAUSED },
    });
    // The abort was made, and is recorded; the resume was tried three times, and never made.
    expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }]);
    expect(kube.failing).toEqual([]);
    expect(kube.object.spec).toMatchObject({ paused: true });
    expect((await controls()).slice(before).map((c) => c.payload)).toEqual([
      { action: 'abort', release: RELEASE, version: commitOf(CANARY), weight: 25 },
    ]);
  });

  it('counts a promotion whose answer was lost as made, though the controller moved the canary on at once', async () => {
    const before = (await controls()).length;
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    // On to the next step, and on again to the pause after it, which sets its pauses again.
    let kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.controller = (object) =>
      merged(object, {
        status: { currentStepIndex: 4, controllerPause: true, pauseConditions: [{ reason: 'CanaryPauseStep' }] },
      }) as Record<string, unknown>;
    kube.failing.push('lost');
    expect(await browser.post('/admin/release/promote', { release: RELEASE })).toMatchObject({ status: 200 });
    // Promoted fully, it is all of the traffic already, and the flag is cleared.
    kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.controller = (object) =>
      merged(object, { status: { promoteFull: null, stableRS: CANARY } }) as Record<string, unknown>;
    kube.failing.push('lost');
    expect(await browser.post('/admin/release/promote', { release: RELEASE, fully: true })).toMatchObject({
      status: 200,
    });
    expect((await controls()).slice(before).map((c) => c.payload.action)).toEqual(['promote', 'promote-fully']);
  });

  it('refuses every control when the admin service has no Rollout', async () => {
    const { browser } = await signedIn();
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({
      status: 503,
      body: { refused: 'rollout' },
    });
  });

  it('controls a release the line recorded under another name, by the name the line gave it', async () => {
    // Recorded before releases were named by revision: under its pod hash alone, and still in flight.
    const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { recorded: false });
    await append(db.as.line, [{ ...started(), payload: { ...started().payload, release: CANARY } }]);
    const { browser } = await signedIn();
    expect(await browser.post('/admin/release/pause', { release: RELEASE })).toMatchObject({
      status: 409,
      body: { refused: 'release' },
    });
    expect(await browser.post('/admin/release/pause', { release: CANARY })).toMatchObject({
      status: 200,
      body: { action: 'pause', release: CANARY },
    });
    expect(kube.patches.map((p) => p.body)).toEqual([{ spec: { paused: true } }]);
    expect((await controls()).at(-1)?.payload).toMatchObject({ action: 'pause', release: CANARY });
    // Ended, so it names no later test's release.
    await append(db.as.line, [
      {
        type: 'release.aborted',
        payload: {
          release: CANARY,
          version: commitOf(CANARY),
          restored: commitOf(STABLE),
          abortedAt: at(1),
          by: 'martin',
        },
      },
    ]);
  });

  describe('stopping and starting the line', () => {
    const lineEvents = () =>
      db.owner<{ type: string; actor: string; appended_by: string; summary: string; payload: Body; public: Body }[]>`
        select type, actor, appended_by, summary, payload, public from events
        where type in ('line.started', 'line.stopped') order by seq`;
    /** The line running, as `make start-the-line` would leave it. */
    const running = () => append(db.operator, [{ type: 'line.started', payload: {}, actor: 'martin' }]);
    const stopped = async () => (await lineEvents()).at(-1)?.type === 'line.stopped';

    it('stops with Martin’s reason, as the command line does, and aborts the canary in flight, recorded as the stop’s', async () => {
      await running();
      const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 }, { paused: true });
      const { browser } = await signedIn();
      const before = (await controls()).length;
      expect(await browser.post('/admin/line/stop', { reason: '  The coder keeps rewriting tests  ' })).toEqual({
        status: 200,
        body: { stopped: true, canary: 'aborted', release: RELEASE, recorded: true },
      });
      const stop = (await lineEvents()).at(-1);
      expect(stop).toMatchObject({
        type: 'line.stopped',
        actor: 'martin',
        appended_by: 'factory_admin',
        summary: 'Martin stopped the line',
        payload: { reason: 'The coder keeps rewriting tests' },
      });
      expect(stop?.public).toMatchObject({ summary: stop?.summary, payload: stop?.payload });
      // The abort, and the pause Martin had set cleared with it, as the panel's abort does.
      expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }, { spec: { paused: false } }]);
      const [control, ...more] = (await controls()).slice(before);
      expect(more).toEqual([]);
      expect(control).toMatchObject({
        appended_by: 'factory_admin',
        summary: `Martin stopped the line, which aborted the canary of ${commitOf(CANARY).slice(0, 7)} at 25%`,
        payload: { action: 'abort', release: RELEASE, version: commitOf(CANARY), weight: 25, stop: true },
      });
    });

    it('refuses to stop a stopped line, and to start a running one, having appended nothing', async () => {
      await running();
      await withRollout({ current: STABLE, stable: STABLE });
      const { browser, passkey } = await signedIn();
      expect((await stepUp(browser, passkey)).status).toBe(200);
      const count = (await lineEvents()).length;
      expect(await browser.post('/admin/line/start', { reason: 'Again' })).toMatchObject({
        status: 409,
        body: { refused: 'line', message: 'The line is running already.' },
      });
      expect(await browser.post('/admin/line/stop', { reason: 'Lunch' })).toMatchObject({
        status: 200,
        body: { stopped: true, canary: 'none' },
      });
      expect(await browser.post('/admin/line/stop', { reason: 'Lunch' })).toMatchObject({
        status: 409,
        body: { refused: 'line', message: 'The line is stopped already.' },
      });
      expect(await lineEvents()).toHaveLength(count + 1);
    });

    it('starts a new store’s line, which has not started, and refuses to stop it, with nothing to stop', async () => {
      await service.stop();
      const shared = db;
      db = await freshDatabase('admin_not_started');
      try {
        await start();
        const { browser, passkey } = await signedIn();
        expect((await stepUp(browser, passkey)).status).toBe(200);
        expect(await browser.post('/admin/line/stop', { reason: 'Lunch' })).toMatchObject({
          status: 409,
          body: { refused: 'line', message: 'The line has not started: there is nothing to stop.' },
        });
        expect(await lineEvents()).toEqual([]);
        expect(await browser.post('/admin/line/start', { reason: 'The first run' })).toEqual({
          status: 200,
          body: { started: true },
        });
        expect((await lineEvents()).map((e) => [e.type, e.appended_by])).toEqual([['line.started', 'factory_admin']]);
      } finally {
        await service.stop();
        await db.end();
        db = shared;
        await start();
      }
    });

    it('starts only with the passkey again, decided from the stored line, with Martin’s reason', async () => {
      await withRollout({ current: STABLE, stable: STABLE });
      const { browser, passkey } = await signedIn();
      if (!(await stopped())) expect((await browser.post('/admin/line/stop', { reason: 'Night' })).status).toBe(200);
      expect(await browser.post('/admin/line/start', { reason: 'Morning' })).toMatchObject({
        status: 403,
        body: { refused: 'step-up' },
      });
      expect(await stopped()).toBe(true);
      expect((await stepUp(browser, passkey)).status).toBe(200);
      expect(await browser.post('/admin/line/start', { reason: 'Morning' })).toEqual({
        status: 200,
        body: { started: true },
      });
      expect((await lineEvents()).at(-1)).toMatchObject({
        type: 'line.started',
        actor: 'martin',
        appended_by: 'factory_admin',
        summary: 'Martin started the line',
        payload: { reason: 'Morning' },
      });
      // A passkey gone stale is asked for again.
      expect((await browser.post('/admin/line/stop', { reason: 'Night' })).status).toBe(200);
      await db.owner`
        update sessions set stepped_up_at = now() - make_interval(mins => ${STEP_UP.minutes + 1})
        where id_sha256 = ${sessionOf(browser)}`;
      expect((await browser.post('/admin/line/start', { reason: 'Morning' })).body.refused).toBe('step-up');
      expect(await stopped()).toBe(true);
    });

    it('takes a reason, for the audit log, and nothing else', async () => {
      await running();
      const { browser } = await signedIn();
      const count = (await lineEvents()).length;
      for (const body of [{}, { reason: '   ' }, { reason: 'x'.repeat(201) }, { reason: 'Why', release: RELEASE }]) {
        expect(await browser.post('/admin/line/stop', body), JSON.stringify(body)).toMatchObject({
          status: 400,
          body: { refused: 'body', message: 'Give a reason, for the audit log.' },
        });
      }
      expect(await lineEvents()).toHaveLength(count);
    });

    it('stays stopped when the abort fails, and says the canary was not aborted and what will abort it', async () => {
      await running();
      const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
      const { browser } = await signedIn();
      const before = (await controls()).length;
      kube.failing.push(403);
      expect(await browser.post('/admin/line/stop', { reason: 'Something is wrong' })).toEqual({
        status: 200,
        body: { stopped: true, canary: 'not-aborted', warning: NOT_ABORTED },
      });
      expect(await stopped()).toBe(true);
      expect(kube.patches).toEqual([]);
      expect(await controls()).toHaveLength(before);
    });

    it('aborts a canary the line has not recorded yet, recording no control: the line tells it by time', async () => {
      await running();
      const kube = await withRollout(
        { current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 },
        { recorded: false },
      );
      const { browser } = await signedIn();
      const before = (await controls()).length;
      expect(await browser.post('/admin/line/stop', { reason: 'Something is wrong' })).toMatchObject({
        status: 200,
        body: { stopped: true, canary: 'aborted', release: RELEASE, recorded: false },
      });
      expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }]);
      expect(await controls()).toHaveLength(before);
    });

    it('waits for a Rollout between releases to name its canary, and aborts it then', async () => {
      await running();
      const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25, behind: true });
      const { browser } = await signedIn();
      // The status catches up a moment after the first read.
      const read = kube.get.bind(kube);
      let reads = 0;
      kube.get = async (path, schema) => {
        reads += 1;
        if (reads === 2)
          kube.object = merged(kube.object, { status: { observedGeneration: '5' } }) as Record<string, unknown>;
        return read(path, schema);
      };
      expect(await browser.post('/admin/line/stop', { reason: 'Something is wrong' })).toMatchObject({
        status: 200,
        body: { stopped: true, canary: 'aborted', release: RELEASE },
      });
      expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }]);
    });

    it.each(['gone', 'unready', 'terminating'] as const)(
      'leaves a canary whose stable version has no pod ready (%s), and says so, the line stopped all the same',
      async (pod) => {
        await running();
        const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
        kube.stablePod = pod;
        const { browser } = await signedIn();
        const before = (await controls()).length;
        expect(await browser.post('/admin/line/stop', { reason: 'Something is wrong' })).toEqual({
          status: 200,
          body: { stopped: true, canary: 'kept', release: RELEASE, warning: NO_STABLE },
        });
        expect(await stopped()).toBe(true);
        // Looked at three times, a second apart, before it is left.
        expect(kube.slices).toEqual(Array(3).fill('/apis/discovery.k8s.io/v1/namespaces/website/endpointslices'));
        expect(kube.patches).toEqual([]);
        expect(await controls()).toHaveLength(before);
      },
    );

    it('aborts a canary whose stable version has a pod ready again at the next look', async () => {
      await running();
      const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
      kube.stablePod = ['unready', 'ready'];
      const { browser } = await signedIn();
      expect(await browser.post('/admin/line/stop', { reason: 'Something is wrong' })).toMatchObject({
        status: 200,
        body: { stopped: true, canary: 'aborted', release: RELEASE },
      });
      expect(kube.slices).toHaveLength(2);
      expect(kube.patches.map((p) => p.body)).toEqual([{ status: { abort: true } }]);
    });

    it.each(['unreachable', 'unserved'] as const)(
      'aborts no canary whose stable version it cannot read (%s), and says what will',
      async (pod) => {
        await running();
        const kube = await withRollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
        kube.stablePod = pod;
        const { browser } = await signedIn();
        expect(await browser.post('/admin/line/stop', { reason: 'Something is wrong' })).toEqual({
          status: 200,
          body: { stopped: true, canary: 'not-aborted', warning: NOT_ABORTED },
        });
        expect(await stopped()).toBe(true);
        expect(kube.patches).toEqual([]);
      },
    );

    it('stops the line and says so when the admin service has no Rollout', async () => {
      await running();
      const { browser } = await signedIn();
      expect(await browser.post('/admin/line/stop', { reason: 'Something is wrong' })).toEqual({
        status: 200,
        body: { stopped: true, canary: 'not-aborted', warning: NO_ROLLOUT },
      });
      expect(await stopped()).toBe(true);
    });
  });
});

describe('the settings', () => {
  /** Policy's defaults on `local`, every field given, as a save that puts them all back. */
  const DEFAULTS = {
    agents: {
      planner: { model: 'claude-sonnet-5-5', effort: 'medium' },
      coder: { model: 'claude-sonnet-5-5', effort: 'medium' },
      reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' },
      describer: { model: 'claude-sonnet-5-5', effort: 'low' },
    },
    caps: { dayUsd: 20, monthUsd: null, workItemUsd: 1 },
  };
  /** Martin signed in, with the settings put back to policy's defaults, and the passkey no longer fresh. */
  async function atDefaults() {
    const signed = await signedIn();
    expect((await stepUp(signed.browser, signed.passkey)).status).toBe(200);
    expect((await signed.browser.post('/admin/settings', DEFAULTS)).status).toBe(200);
    await db.owner`update sessions set stepped_up_at = null where id_sha256 = ${sessionOf(signed.browser)}`;
    return signed;
  }
  const settingsEvents = async () => (await db.owner`select 1 from events where type = 'settings.changed'`).length;
  const inForceNow = () => settingsNow(db.owner, 'local');

  it('saves a cheaper model, less effort and a lower cap without the passkey again, as one public event', async () => {
    const { browser } = await atDefaults();
    const saved = await browser.post('/admin/settings', {
      agents: { coder: { model: 'claude-haiku-5-5' }, reviewer: { effort: 'low' } },
      caps: { dayUsd: 10.5, monthUsd: 90 },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const changes = [
      { field: 'model', agent: 'coder', before: 'claude-sonnet-5-5', after: 'claude-haiku-5-5' },
      { field: 'effort', agent: 'reviewer', before: 'medium', after: 'low' },
      { field: 'cap', cap: 'day', beforeUsd: 20, afterUsd: 10.5 },
      { field: 'cap', cap: 'month', beforeUsd: null, afterUsd: 90 },
    ];
    expect(saved.body).toMatchObject({ changes, answered: [] });
    const [event] = await lastEvents(1);
    expect(event).toMatchObject({ type: 'settings.changed', actor: 'martin', payload: { changes } });
    expect(event?.summary).toBe(
      "Martin changed the coder's model, claude-sonnet-5-5 → claude-haiku-5-5; the reviewer's effort, medium → low; " +
        "the day's cap, $20.00 → $10.50; the month's cap, none → $90.00",
    );
    // Everyone sees the settings: the public view is the event.
    expect(event?.public).toMatchObject({ payload: event?.payload });
    const settings = await inForceNow();
    expect(settings.agents.coder).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' });
    expect(settings.caps).toEqual({ dayUsd: 10.5, monthUsd: 90, workItemUsd: 1 });
    // No month's cap is policy's default: on `local`, none, which is a raise from $90.
    expect((await browser.post('/admin/settings', { caps: { monthUsd: null } })).body.refused).toBe('step-up');
    // Saving what is already in force changes nothing, and records nothing.
    const before = await settingsEvents();
    expect((await browser.post('/admin/settings', { caps: { dayUsd: 10.5 } })).body).toMatchObject({ changes: [] });
    expect(await settingsEvents()).toBe(before);
  });

  it('saves over a setting for a model no longer offered from what is in force, the agent’s default model', async () => {
    const { browser } = await atDefaults();
    // Claude Haiku 4.5 was offered until Haiku 5.5 took its place: Martin's last save may name it.
    await appendSettings(
      db.admin,
      settingsPayload({ agents: { coder: { model: 'claude-haiku-4-5', effort: 'low' } } }),
    );
    expect((await inForceNow()).outside).toEqual(['coder.model']);
    const saved = await browser.post('/admin/settings', { agents: { reviewer: { effort: 'low' } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({
      changes: [{ field: 'effort', agent: 'reviewer', before: 'medium', after: 'low' }],
    });
    const [event] = await lastEvents(1);
    expect(event?.payload).toMatchObject({ agents: { coder: { model: 'claude-sonnet-5-5', effort: 'low' } } });
    const settings = await inForceNow();
    expect(settings.outside).toEqual([]);
    expect(settings.agents.coder).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it('asks for the passkey again for a dearer model, more effort or a higher cap, alone or with a lower one', async () => {
    const { browser, passkey } = await atDefaults();
    const raises = [
      { agents: { coder: { model: 'claude-opus-5-5' } } },
      { agents: { planner: { effort: 'high' } } },
      // Qwen costs nothing, so Claude from it is dearer.
      { agents: { describer: { model: 'claude-sonnet-5-5' } }, caps: { workItemUsd: 2 } },
      { caps: { dayUsd: 25 } },
      { agents: { coder: { model: 'claude-opus-5-5', effort: 'low' } }, caps: { dayUsd: 5 } },
    ];
    const before = await settingsEvents();
    for (const save of raises) {
      expect(await browser.post('/admin/settings', save), JSON.stringify(save)).toMatchObject({
        status: 403,
        body: { refused: 'step-up' },
      });
    }
    expect(await settingsEvents()).toBe(before);
    // To Qwen is cheaper; back to Claude is dearer.
    expect(
      (await browser.post('/admin/settings', { agents: { describer: { model: 'qwen/qwen3.8-27b' } } })).status,
    ).toBe(200);
    expect(
      (await browser.post('/admin/settings', { agents: { describer: { model: 'claude-haiku-5-5' } } })).body.refused,
    ).toBe('step-up');
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const saved = await browser.post('/admin/settings', raises[4] as Body);
    expect(saved.status).toBe(200);
    expect((await inForceNow()).agents.coder).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'low',
    });
  });

  it('refuses a save outside policy whole, having changed nothing, passkey or no', async () => {
    const { browser, passkey } = await atDefaults();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const before = await settingsEvents();
    for (const save of [
      { agents: { coder: { model: 'gpt-9' } } },
      { agents: { describer: { effort: 'high' } } },
      { agents: { coder: { effort: 'ultra' } } },
      { agents: { coder: { model: 'qwen/qwen3.8-27b', effort: 'low' } } },
      { caps: { dayUsd: 25.01 } },
      { caps: { dayUsd: 0 } },
      { caps: { monthUsd: 251 } },
      { caps: { workItemUsd: -1 } },
      { caps: { workItemUsd: 11 }, agents: { coder: { model: 'claude-haiku-5-5' } } },
    ]) {
      expect(await browser.post('/admin/settings', save), JSON.stringify(save)).toMatchObject({
        status: 422,
        body: { refused: 'policy' },
      });
    }
    for (const save of [{ caps: { dayUsd: '25' } }, { agents: { triage: { model: 'claude-opus-5-5' } } }, { all: 1 }]) {
      expect(await browser.post('/admin/settings', save), JSON.stringify(save)).toMatchObject({
        status: 400,
        body: { refused: 'body' },
      });
    }
    expect(await settingsEvents()).toBe(before);
  });

  it('answers each spend hold a raised work item cap clears, with the settings, and none the day’s cap raises', async () => {
    const { browser, passkey } = await atDefaults();
    const writer = (workItem: string, type: string, payload: object) => ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type as keyof typeof VERSIONS],
      actor: 'factory',
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    });
    const hold = (spentUsd?: number) => ({
      stage: 'build',
      kind: 'held',
      cause: 'spend',
      reason: 'The work item has spent its cap',
      limitUsd: 1,
      ...(spentUsd !== undefined && { spentUsd }),
    });
    const sql = db.as.triage;
    // Numbered one after another, so they sort as they were opened.
    const numbers: string[] = [];
    for (let i = 0; i < 7; i++) numbers.push(await nextWorkItem(sql));
    const [a, b, c, d, e, f, g] = numbers;
    const opened = (workItem: string) =>
      writer(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'Server errors', sample: false });
    const holdOfA = writer(a as string, 'hold.started', hold(1.4));
    await sql.begin((tx) =>
      appendMartins(sql, tx, [
        ...[a, b, c, d, e, f, g].map((workItem) => opened(workItem as string)),
        holdOfA,
        writer(b as string, 'hold.started', hold(3.2)),
        // From before the line recorded the spend: the cap it reached is all there is to go on.
        writer(c as string, 'hold.started', hold()),
        writer(d as string, 'hold.started', { ...hold(1.1), cause: 'failures' }),
        writer(e as string, 'hold.started', hold(1.2)),
        writer(e as string, 'work-item.closed', { outcome: 'no-change', reason: 'Martin rejected it' }),
        // Held, closed with the hold unanswered, then reopened: no hold is open on it.
        // Held, then merged by Martin, which answers whatever held it.
        writer(g as string, 'hold.started', hold(1.1)),
        writer(g as string, 'pull-request.merged', { number: 7, commit: 'a'.repeat(40), by: 'martin' }),
        writer(f as string, 'hold.started', hold(1.3)),
        writer(f as string, 'work-item.closed', { outcome: 'verified', reason: 'Cleared' }),
        writer(f as string, 'work-item.reopened', {
          sense: 'probe',
          check: 'search answers',
          route: '/search',
          version: 'v0.9.4',
          reason: 'It came back',
          dryRun: false,
        }),
      ] as NewEvent[]),
    );
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await browser.post('/admin/settings', { caps: { dayUsd: 25 } })).body).toMatchObject({ answered: [] });
    const saved = await browser.post('/admin/settings', { caps: { workItemUsd: 2 } });
    expect(saved.body).toMatchObject({ answered: [a, c] });
    const answers = await db.owner<{ work_item: string; type: string; actor: string; payload: Body }[]>`
      select work_item, type, actor, payload from events
      where type = 'hold.answered' and work_item in (${a as string}, ${b as string}, ${c as string}, ${d as string})
      order by seq`;
    expect(answers).toEqual([
      {
        work_item: a,
        type: 'hold.answered',
        actor: 'martin',
        payload: {
          decision: 'approved',
          answer: "Martin raised a work item's cap to $2.00, past the $1.40 this one has spent.",
          hold: holdOfA.id,
        },
      },
      expect.objectContaining({ work_item: c, payload: expect.objectContaining({ decision: 'approved' }) }),
    ]);
    // One transaction: the settings and the answers it made are appended together, the settings first.
    const [settings, ...rest] = await lastEvents(3).then((events) => events.reverse());
    expect([settings?.type, ...rest.map((e) => e.type)]).toEqual([
      'settings.changed',
      'hold.answered',
      'hold.answered',
    ]);
    // Answered once: raising it again answers only the one the new cap clears now.
    expect((await browser.post('/admin/settings', { caps: { workItemUsd: 5 } })).body).toMatchObject({
      answered: [b],
    });
  });
});

describe('the line’s controls', () => {
  const event = (workItem: string | null, type: string, actor: string, payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type as keyof typeof VERSIONS],
      actor,
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    }) as NewEvent;
  const append = (sql: Sql, events: NewEvent[]) =>
    new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }).append(events);

  /** The controls as stored, from Martin's command line's role, so each test starts from what it says. */
  const stored = (controls: Partial<PayloadOf<'controls.changed'>>) =>
    append(db.operator, [
      event(null, 'controls.changed', 'martin', {
        autonomy: 'supervised',
        newWork: true,
        autoMerge: false,
        take: null,
        autoRollback: true,
        change: { control: 'new-work', before: false, after: true },
        ...controls,
      }),
    ]);

  const changes = () =>
    db.owner<{ appended_by: string; summary: string; payload: Body; public: Body }[]>`
      select appended_by, summary, payload, public from events where type = 'controls.changed' order by seq`;

  /** A work item with a ticket, as triage opens one; closed, if asked. */
  async function ticketed(closed = false): Promise<string> {
    const workItem = await nextWorkItem(db.as.triage);
    await append(db.as.triage, [
      event(workItem, 'work-item.opened', 'probe', { kind: 'defect-fix', title: 'A page for the test', sample: false }),
      event(workItem, 'ticket.opened', 'triage', {
        title: 'A page for the test',
        category: 'errors',
        severity: 'broken',
        fingerprint: { route: '/search', class: 'server-error' },
        traces: [],
      }),
      ...(closed
        ? [event(workItem, 'work-item.closed', 'triage', { outcome: 'no-change', reason: 'Closed for the test' })]
        : []),
    ]);
    return workItem;
  }

  it('loosens autonomy only with the passkey again, and tightens it without, as one public event each', async () => {
    await stored({});
    const { browser, passkey } = await signedIn();
    const before = (await changes()).length;
    expect(await browser.post('/admin/line/controls', { autonomy: 'guarded' })).toMatchObject({
      status: 403,
      body: { refused: 'step-up' },
    });
    expect(await changes()).toHaveLength(before);
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/line/controls', { autonomy: 'guarded' })).toEqual({
      status: 200,
      body: {
        controls: { autonomy: 'guarded', newWork: true, autoMerge: false, take: { kind: 'every' }, autoRollback: true },
        change: { control: 'autonomy', before: 'supervised', after: 'guarded' },
      },
    });
    const [loosened] = (await changes()).slice(before);
    expect(loosened).toMatchObject({
      appended_by: 'factory_admin',
      summary: 'Martin loosened autonomy from Supervised to Guarded',
      payload: {
        autonomy: 'guarded',
        newWork: true,
        autoMerge: false,
        take: { kind: 'every' },
        change: { control: 'autonomy', before: 'supervised', after: 'guarded' },
      },
    });
    expect(loosened?.public).toMatchObject({ summary: loosened?.summary, payload: loosened?.payload });
    // A fresh session, the passkey not given again: tightening asks nothing.
    const other = (await signedIn()).browser;
    expect(await other.post('/admin/line/controls', { autonomy: 'supervised' })).toMatchObject({ status: 200 });
    expect((await changes()).at(-1)?.summary).toBe('Martin tightened autonomy from Guarded to Supervised');
  });

  it('decides what a change does from the controls in force, never from the request', async () => {
    // Lights-out in force: Guarded is a tightening, and asks nothing.
    await stored({ autonomy: 'lights-out', autoMerge: true });
    const { browser } = await signedIn();
    expect(await browser.post('/admin/line/controls', { autonomy: 'guarded' })).toMatchObject({
      status: 200,
      body: { change: { control: 'autonomy', before: 'lights-out', after: 'guarded' } },
    });
    expect((await changes()).at(-1)?.summary).toBe('Martin tightened autonomy from Lights-out to Guarded');
    // Every other control stays as it was in force.
    expect((await changes()).at(-1)?.payload).toMatchObject({ autoMerge: true });
    // What policy does not allow is not in force, whatever the event says: the next fifty are more than it allows, so
    // every ticket is, and the next three are narrower, and ask nothing.
    await stored({ take: { kind: 'next-few', count: 50, since: new Date().toISOString() } });
    expect(await browser.post('/admin/line/controls', { take: { kind: 'next-few', count: 3 } })).toMatchObject({
      status: 200,
      body: { change: { control: 'take', before: { kind: 'every' } } },
    });
    expect((await changes()).at(-1)?.summary).toBe('Martin narrowed what the line takes to the next 3 from now');
  });

  it('turns new work off and on without the passkey, and auto-merge on only with it', async () => {
    await stored({});
    const { browser, passkey } = await signedIn();
    expect(await browser.post('/admin/line/controls', { newWork: false })).toMatchObject({ status: 200 });
    expect((await changes()).at(-1)?.summary).toBe('Martin stopped agents taking new work');
    expect(await browser.post('/admin/line/controls', { newWork: true })).toMatchObject({ status: 200 });
    expect((await changes()).at(-1)?.summary).toBe('Martin let agents take new work again');
    expect((await browser.post('/admin/line/controls', { autoMerge: true })).body.refused).toBe('step-up');
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/line/controls', { autoMerge: true })).toMatchObject({ status: 200 });
    expect((await changes()).at(-1)?.summary).toBe('Martin turned on auto-merge of low-risk changes');
    const other = (await signedIn()).browser;
    expect(await other.post('/admin/line/controls', { autoMerge: false })).toMatchObject({ status: 200 });
  });

  it('turns auto-rollback off only with the passkey again, and on without, as one public event each', async () => {
    await stored({});
    const { browser, passkey } = await signedIn();
    const before = (await changes()).length;
    expect(await browser.post('/admin/line/controls', { autoRollback: false })).toMatchObject({
      status: 403,
      body: { refused: 'step-up' },
    });
    expect(await changes()).toHaveLength(before);
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/line/controls', { autoRollback: false })).toMatchObject({
      status: 200,
      body: { controls: { autoRollback: false }, change: { control: 'auto-rollback', before: true, after: false } },
    });
    const off = (await changes()).at(-1);
    expect(off).toMatchObject({
      appended_by: 'factory_admin',
      summary: 'Martin turned off auto-rollback: a canary whose errors or latency are judged bad pauses for him',
      payload: { autoRollback: false, change: { control: 'auto-rollback', before: true, after: false } },
    });
    // Off again records nothing.
    expect(await browser.post('/admin/line/controls', { autoRollback: false })).toMatchObject({
      status: 200,
      body: { change: null },
    });
    expect(await changes()).toHaveLength(before + 1);
    // On tightens, and asks for nothing: another session, never stepped up, turns it on.
    const other = (await signedIn()).browser;
    expect(await other.post('/admin/line/controls', { autoRollback: true })).toMatchObject({ status: 200 });
    expect((await changes()).at(-1)?.summary).toBe(
      'Martin turned on auto-rollback: a canary judged bad rolls back by itself',
    );
    // Every other control keeps it as it stands.
    expect(await other.post('/admin/line/controls', { newWork: false })).toMatchObject({
      status: 200,
      body: { controls: { autoRollback: true } },
    });
  });

  it('asks for the passkey again to widen what the line takes, and not to narrow it, counting the next few from each time he chooses them', async () => {
    await stored({});
    const workItem = await ticketed();
    const { browser, passkey } = await signedIn();
    // With no take set, the line takes every ticket: choosing it changes nothing, and records nothing.
    const before = (await changes()).length;
    expect(await browser.post('/admin/line/controls', { take: { kind: 'every' } })).toMatchObject({
      status: 200,
      body: { controls: { take: { kind: 'every' } }, change: null },
    });
    expect(await changes()).toHaveLength(before);
    // A first take narrows every ticket, whatever it is, and asks nothing.
    expect(await browser.post('/admin/line/controls', { take: { kind: 'just-one', workItem } })).toMatchObject({
      status: 200,
      body: { controls: { take: { kind: 'just-one', workItem } } },
    });
    expect((await changes()).at(-1)?.summary).toBe(`Martin narrowed what the line takes to just #${workItem}`);
    // The next few are wider than just one.
    expect((await browser.post('/admin/line/controls', { take: { kind: 'next-few', count: 3 } })).body.refused).toBe(
      'step-up',
    );
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/line/controls', { take: { kind: 'next-few', count: 3 } })).toMatchObject({
      status: 200,
    });
    const since = ((await changes()).at(-1)?.payload.take as { since: string } | undefined)?.since ?? '';
    expect(Date.now() - Date.parse(since)).toBeLessThan(60_000);
    // To the microsecond, as the line stamps each work item it takes.
    expect(since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    expect((await changes()).at(-1)?.summary).toBe('Martin widened what the line takes to the next 3 from now');
    // Any number chosen counts again from now, fewer and the same too: with some taken already, that may let the line
    // take more, so each asks for the passkey again.
    const again = await browser.post('/admin/line/controls', { take: { kind: 'next-few', count: 2 } });
    expect(again).toMatchObject({ status: 200, body: { controls: { take: { kind: 'next-few', count: 2 } } } });
    const restarted = (again.body as { controls: { take: { since: string } } }).controls.take.since;
    expect(restarted > since).toBe(true);
    expect((await changes()).at(-1)?.summary).toBe('Martin widened what the line takes to the next 2 from now');
    // Without the passkey again, none of them.
    const other = (await signedIn()).browser;
    for (const take of [
      { kind: 'next-few', count: 1 },
      { kind: 'next-few', count: 2 },
      { kind: 'next-few', count: 5 },
      { kind: 'every' },
    ]) {
      expect((await other.post('/admin/line/controls', { take })).body.refused, JSON.stringify(take)).toBe('step-up');
    }
    expect(await other.post('/admin/line/controls', { take: { kind: 'just-one', workItem } })).toMatchObject({
      status: 200,
    });
    // Just one, moved to another work item, is no wider.
    const another = await ticketed();
    expect(await other.post('/admin/line/controls', { take: { kind: 'just-one', workItem: another } })).toMatchObject({
      status: 200,
    });
  });

  it('takes just one improvement Martin asked for, and none without his request', async () => {
    await stored({ take: { kind: 'every' } });
    const asked = await nextWorkItem(db.as.triage);
    await append(db.admin, [
      event(asked, 'work-item.opened', 'martin', { kind: 'improvement', title: 'Delivery dates', sample: false }),
      event(asked, 'improvement.requested', 'martin', { words: 'Delivery dates.', steppedUp: true }),
    ]);
    // His command line's improvement with no request is none the line takes.
    const unasked = await nextWorkItem(db.as.triage);
    await append(db.operator, [
      event(unasked, 'work-item.opened', 'martin', { kind: 'improvement', title: 'Gift notes', sample: false }),
    ]);
    // A worker's ticket on it does not make it a ticket either: the line's queue judges it by its opening too.
    await append(db.as.triage, [
      event(unasked, 'ticket.opened', 'triage', {
        title: 'A ticket on an improvement',
        category: 'errors',
        severity: 'broken',
        fingerprint: { route: '/', class: 'server-error' },
        traces: [],
      }),
    ]);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/line/controls', { take: { kind: 'just-one', workItem: unasked } })).toMatchObject(
      {
        status: 422,
        body: { refused: 'policy', message: `#${unasked} has no open ticket or improvement for the line to take.` },
      },
    );
    expect(await browser.post('/admin/line/controls', { take: { kind: 'just-one', workItem: asked } })).toMatchObject({
      status: 200,
      body: { change: { control: 'take', after: { kind: 'just-one', workItem: asked } } },
    });
    // Released and handed over, it is still his to choose: the flag pass then judges its flag alone.
    const released = await nextWorkItem(db.as.triage);
    await append(db.admin, [
      event(released, 'work-item.opened', 'martin', { kind: 'improvement', title: 'Gift notes', sample: false }),
      event(released, 'improvement.requested', 'martin', { words: 'Gift notes.', steppedUp: true }),
    ]);
    const release = { release: '6d8f9c7b54', version: 'v0.9.4', previous: 'v0.9.3', watched: true, dryRun: false };
    await append(db.as.line, [
      event(released, 'pull-request.merged', 'martin', { number: 12, commit: 'c'.repeat(40), by: 'martin' }),
      event(released, 'release.promoted', 'rollouts', release),
    ]);
    expect(
      (await browser.post('/admin/line/controls', { take: { kind: 'just-one', workItem: released } })).status,
    ).toBe(200);
  });

  it('refuses a change outside policy, passkey or no, and records nothing for one already in force', async () => {
    await stored({ take: { kind: 'every' } });
    const closed = await ticketed(true);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const before = (await changes()).length;
    for (const take of [
      { kind: 'next-few', count: 0 },
      { kind: 'next-few', count: 21 },
      { kind: 'next-few', count: 2.5 },
      { kind: 'just-one', workItem: 'abc' },
      { kind: 'just-one', workItem: '999999' },
      { kind: 'just-one', workItem: closed },
    ]) {
      expect(await browser.post('/admin/line/controls', { take }), JSON.stringify(take)).toMatchObject({
        status: 422,
        body: { refused: 'policy' },
      });
    }
    for (const body of [{}, { newWork: true, autoMerge: true }, { autoRollback: 'off' }, { autonomy: 'yolo' }]) {
      expect(await browser.post('/admin/line/controls', body), JSON.stringify(body)).toMatchObject({
        status: 400,
        body: { refused: 'body' },
      });
    }
    expect(await browser.post('/admin/line/controls', { take: { kind: 'every' } })).toMatchObject({
      status: 200,
      body: { change: null },
    });
    expect(await changes()).toHaveLength(before);
  });
});

describe('alerts to the phone', () => {
  const switches = () =>
    db.owner<{ appended_by: string; summary: string; payload: Body; public: Body }[]>`
      select appended_by, summary, payload, public from events where type = 'alerts.switched' order by seq`;
  /** The switch as stored, from Martin's command line's role, so each test starts from what it says. */
  const stored = (phone: boolean) =>
    new EventWriter(db.operator, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }).append({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: null,
      type: 'alerts.switched',
      version: VERSIONS['alerts.switched'],
      actor: 'martin',
      summary: 'alerts.switched for the test',
      payload: { phone },
      artifacts: [],
    } as NewEvent);

  it('switches them on without the passkey, and off only with it, as one public event each', async () => {
    await stored(false);
    const { browser, passkey } = await signedIn();
    const before = (await switches()).length;
    expect(await browser.post('/admin/alerts/phone', { phone: true })).toEqual({
      status: 200,
      body: { phone: true, changed: true },
    });
    const [on] = (await switches()).slice(before);
    expect(on).toMatchObject({
      appended_by: 'factory_admin',
      summary: 'Martin sent every alert to his phone',
      payload: { phone: true },
    });
    expect(on?.public).toMatchObject({ summary: on?.summary, payload: on?.payload });
    expect(await browser.post('/admin/alerts/phone', { phone: false })).toMatchObject({
      status: 403,
      body: { refused: 'step-up' },
    });
    expect(await switches()).toHaveLength(before + 1);
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await browser.post('/admin/alerts/phone', { phone: false })).toMatchObject({
      status: 200,
      body: { phone: false, changed: true },
    });
    expect((await switches()).at(-1)).toMatchObject({
      summary: 'Martin stopped alerts reaching his phone',
      payload: { phone: false },
    });
  });

  it('records nothing, and asks nothing, for what is already in force', async () => {
    const { browser } = await signedIn();
    await stored(true);
    const before = (await switches()).length;
    expect(await browser.post('/admin/alerts/phone', { phone: true })).toEqual({
      status: 200,
      body: { phone: true, changed: false },
    });
    await stored(false);
    // Off already: the passkey not given again, and none asked for.
    expect(await browser.post('/admin/alerts/phone', { phone: false })).toEqual({
      status: 200,
      body: { phone: false, changed: false },
    });
    expect(await switches()).toHaveLength(before + 1);
  });

  it('refuses anything but a yes or no', async () => {
    const { browser } = await signedIn();
    for (const body of [{}, { phone: 'off' }, { phone: true, level: 'page' }]) {
      expect(await browser.post('/admin/alerts/phone', body), JSON.stringify(body)).toMatchObject({
        status: 400,
        body: { refused: 'body' },
      });
    }
  });
});

describe('Needs you', () => {
  const event = (workItem: string, type: string, actor: string, payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type as keyof typeof VERSIONS],
      actor,
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    }) as NewEvent;
  const append = (sql: Sql, events: NewEvent[]) =>
    new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }).append(events);

  /**
   * A work item held for this cause, as the line or triage holds it, opened by a sense's signal or a visitor's report:
   * its number, and its hold's id.
   */
  async function held(
    cause: string,
    { report = false, stage = 'build' }: { report?: boolean; stage?: string } = {},
  ): Promise<{ workItem: string; hold: string }> {
    const triage = ['suggestion', 'finding', 'burst', 'environment'].includes(cause);
    const workItem = await nextWorkItem(db.as.triage);
    const hold = event(workItem, 'hold.started', triage ? 'triage' : 'factory', {
      stage: triage ? 'triage' : stage,
      kind: 'held',
      cause,
      reason: `Held for the test: ${cause}`,
      ...(cause === 'finding' && {
        defect: { fingerprint: { route: '/about', class: 'broken-link' }, symptom: 'broken-link' },
      }),
    });
    await append(db.as.triage, [
      event(workItem, 'work-item.opened', report ? 'visitor' : 'probe', {
        kind: report ? 'visitor-report' : 'defect-fix',
        title: 'A page for the test',
        sample: false,
      }),
      event(workItem, 'signal.received', report ? 'visitor' : 'probe', {
        sense: report ? 'report' : 'probe',
        check: report ? 'a visitor’s report' : 'search answers',
        route: '/search',
        version: 'v0.9.4',
        ...(report
          ? { report: { page: '/search', text: 'The search box ate my words' } }
          : { symptom: 'server-error' }),
      }),
    ]);
    await append(triage ? db.as.triage : db.as.line, [hold]);
    return { workItem, hold: hold.id };
  }
  /** The hold the line's own fold finds open on a work item, as the line reads its events. */
  const lineHold = async (workItem: string) => {
    const rows = await db.owner<{ seq: string; type: string; version: number; payload: unknown }[]>`
      select seq, type, version, payload from events where work_item = ${workItem} order by seq`;
    const read = rows.flatMap((row) => {
      const got = upcast({ ...row, seq: Number(row.seq) });
      return got.ok ? [{ type: got.event.type, payload: got.event.payload }] : [];
    });
    const state = fold(read as LineEvent[]);
    return state.closed ? undefined : state.hold;
  };
  const answers = (workItem: string) => db.owner<{ actor: string; payload: Body; public: Body }[]>`
    select actor, payload, public from events where work_item = ${workItem} and type = 'hold.answered' order by seq`;

  it('appends Martin’s answer to the hold the card showed, naming it, and refuses one to a hold no longer open', async () => {
    const { browser } = await signedIn();
    const { workItem, hold } = await held('question', { stage: 'plan' });
    const said = await browser.post(`/admin/holds/${workItem}/answer`, { hold, words: '  The home page first  ' });
    expect(said, JSON.stringify(said.body)).toMatchObject({
      status: 200,
      body: { workItem, hold, decision: 'answered', report: false },
    });
    expect(await answers(workItem)).toEqual([
      {
        actor: 'martin',
        payload: { decision: 'answered', answer: 'The home page first', hold },
        public: expect.objectContaining({ payload: { decision: 'answered', answer: 'The home page first', hold } }),
      },
    ]);
    // Answered: a second answer, from this card or another tab, finds no hold waiting.
    for (const [path, body] of [
      ['approve', { hold }],
      ['reject', { hold }],
      ['answer', { hold, words: 'Again' }],
    ] as const) {
      expect(await browser.post(`/admin/holds/${workItem}/${path}`, body)).toMatchObject({
        status: 409,
        body: { refused: 'hold' },
      });
    }
    expect(await answers(workItem)).toHaveLength(1);
  });

  it('refuses an answer to a hold ended, replaced or never there, having appended nothing', async () => {
    const { browser } = await signedIn();
    const closed = await held('failures');
    await append(db.as.line, [
      event(closed.workItem, 'work-item.closed', 'factory', { outcome: 'no-change', reason: 'Gone' }),
    ]);
    const replaced = await held('failures');
    await append(db.as.line, [
      event(replaced.workItem, 'hold.started', 'factory', {
        stage: 'build',
        kind: 'held',
        cause: 'failures',
        reason: 'Held again',
      }),
    ]);
    const merged = await held('failures');
    await append(db.as.line, [
      event(merged.workItem, 'pull-request.merged', 'factory', { number: 7, commit: 'a'.repeat(40), by: 'martin' }),
    ]);
    const failed = await held('merge', { stage: 'review' });
    // Gates that ran on the push, then fail on it again (main merged in), end the wait for his merge.
    await append(db.as.line, [
      event(failed.workItem, 'gates.started', 'factory', { pullRequest: 7, commit: 'b'.repeat(40), checks: ['test'] }),
      event(failed.workItem, 'gates.finished', 'factory', {
        pullRequest: 7,
        commit: 'b'.repeat(40),
        conclusion: 'failed',
        passed: 3,
        failed: ['test'],
      }),
    ]);
    // A merged fix waiting for its deploy, which a release carrying it ends; and a wait for a deploy decided as a
    // release started, which the line reads as already ended by it.
    const released = await held('failures');
    const merge = event(released.workItem, 'pull-request.merged', 'factory', {
      number: 8,
      commit: 'c'.repeat(40),
      by: 'martin',
    });
    const start = (workItem: string) =>
      event(workItem, 'release.started', 'factory', {
        release: '68ff668868-4',
        version: 'v0.9.5',
        previous: 'v0.9.4',
        watched: true,
        steps: null,
        dryRun: true,
      });
    const deploy = (workItem: string) =>
      event(workItem, 'hold.started', 'factory', {
        stage: 'release',
        kind: 'approval',
        cause: 'deploy',
        reason: 'Waiting for a deploy',
      });
    const late = deploy(released.workItem);
    await append(db.as.line, [merge, late, start(released.workItem)]);
    const inFlight = await held('failures');
    const early = deploy(inFlight.workItem);
    await append(db.as.line, [
      { ...merge, id: crypto.randomUUID(), work_item: inFlight.workItem } as NewEvent,
      start(inFlight.workItem),
      early,
    ]);
    const other = await held('failures');
    for (const [workItem, hold] of [
      [closed.workItem, closed.hold],
      [failed.workItem, failed.hold],
      [released.workItem, late.id],
      [inFlight.workItem, early.id],
      [replaced.workItem, replaced.hold],
      [merged.workItem, merged.hold],
      // Another work item's hold, named on this one.
      [other.workItem, closed.hold],
    ]) {
      expect(await browser.post(`/admin/holds/${workItem}/reject`, { hold }), workItem).toMatchObject({
        status: 409,
        body: { refused: 'hold' },
      });
      expect(await answers(workItem as string)).toEqual([]);
      // The line reads it the same way: its hold, if it has one, is not the one named.
      if (workItem !== other.workItem && workItem !== replaced.workItem)
        expect(await lineHold(workItem as string)).toBeUndefined();
    }
    expect(await lineHold(replaced.workItem)).toMatchObject({ reason: 'Held again' });
    // A work item with no hold at all, and one that is not a number.
    const none = await nextWorkItem(db.as.triage);
    expect((await browser.post(`/admin/holds/${none}/reject`, { hold: other.hold })).status).toBe(409);
    expect((await browser.post('/admin/holds/1a/reject', { hold: other.hold })).status).toBe(400);
    expect((await browser.post(`/admin/holds/${other.workItem}/reject`, { hold: 'not-a-hold' })).status).toBe(400);
    // An answer in words with none takes none, and appends nothing.
    expect((await browser.post(`/admin/holds/${other.workItem}/answer`, { hold: other.hold })).status).toBe(422);
    expect(
      (
        await browser.post(`/admin/holds/${other.workItem}/answer`, {
          hold: other.hold,
          words: 'x'.repeat(MARTIN_ANSWER_CHARS + 1),
        })
      ).status,
    ).toBe(400);
  });

  it('sends a work item back to the planner, with his words, only from a hold whose words go to the coder', async () => {
    const { browser } = await signedIn();
    const words = 'The spec contradicts files > keeps nothing of the other files in test/app.test.ts';
    const { workItem, hold } = await held('review', { stage: 'review' });
    // Words are his reason for it: none, or only spaces, is refused, having changed nothing.
    expect(await browser.post(`/admin/holds/${workItem}/replan`, { hold })).toMatchObject({
      status: 422,
      body: { refused: 'words', message: 'That answer takes your words.' },
    });
    expect(await browser.post(`/admin/holds/${workItem}/replan`, { hold, words: '   ' })).toMatchObject({
      status: 400,
      body: { refused: 'body', message: 'Send the hold, and your words if it takes them.' },
    });
    expect(await answers(workItem)).toEqual([]);
    const sent = await browser.post(`/admin/holds/${workItem}/replan`, { hold, words: `  ${words}  ` });
    expect(sent, JSON.stringify(sent.body)).toMatchObject({
      status: 200,
      body: { workItem, hold, decision: 'replanned', report: false },
    });
    expect(await answers(workItem)).toEqual([
      expect.objectContaining({ actor: 'martin', payload: { decision: 'replanned', answer: words, hold } }),
    ]);
    const [summary] = await db.owner<{ summary: string }[]>`
      select summary from events where work_item = ${workItem} and type = 'hold.answered'`;
    expect(summary?.summary).toBe(`Martin sent the hold on #${workItem} back to the planner`);
    // The line reads it as it reads any answer that replans: no hold, and back to Plan.
    expect(await lineHold(workItem)).toBeUndefined();
    // Offered on the holds before a merge whose words go to the coder; refused on every other, by the stored cause.
    for (const cause of ['gates', 'merge']) {
      const other = await held(cause);
      expect((await browser.post(`/admin/holds/${other.workItem}/replan`, { hold: other.hold, words })).status).toBe(
        200,
      );
    }
    for (const [cause, stage] of [
      ['spec', 'plan'],
      ['question', 'plan'],
      ['scope', 'build'],
      ['failures', 'build'],
      ['deploy', 'release'],
      ['spend', 'build'],
      ['suggestion', 'triage'],
      ['finding', 'triage'],
    ] as const) {
      const other = await held(cause, { stage });
      expect(
        await browser.post(`/admin/holds/${other.workItem}/replan`, { hold: other.hold, words }),
        cause,
      ).toMatchObject({ status: 422, body: { refused: 'answer' } });
      expect(await answers(other.workItem), cause).toEqual([]);
    }
  });

  it('takes no answer of a canary’s hold, and finds it ended with its release, as the line does', async () => {
    const { browser } = await signedIn();
    for (const end of ['release.promoted', 'release.rolled-back'] as const) {
      const { workItem } = await held('failures');
      const release = { release: '68ff668868-4', version: 'v0.9.5', previous: 'v0.9.4', watched: true, dryRun: false };
      const hold = event(workItem, 'hold.started', 'rollouts', {
        stage: 'release',
        kind: 'held',
        cause: 'canary',
        reason: 'The analysis judged the canary bad',
        release: release.release,
      });
      await append(db.as.line, [
        event(workItem, 'pull-request.merged', 'martin', { number: 8, commit: 'c'.repeat(40), by: 'martin' }),
        event(workItem, 'release.started', 'rollouts', {
          ...release,
          image: { digest: `sha256:${'a'.repeat(64)}`, signed: true, admitted: true },
          steps: null,
        }),
        hold,
      ]);
      expect(await browser.post(`/admin/holds/${workItem}/reject`, { hold: hold.id }), end).toMatchObject({
        status: 422,
        body: { refused: 'answer' },
      });
      await append(db.as.line, [
        end === 'release.promoted'
          ? event(workItem, end, 'rollouts', release)
          : event(workItem, end, 'martin', {
              release: release.release,
              version: release.version,
              restored: release.previous,
              weight: 50,
              reason: 'Judged bad',
              failed: [],
              dryRun: false,
              by: 'martin',
            }),
      ]);
      expect(await browser.post(`/admin/holds/${workItem}/reject`, { hold: hold.id }), end).toMatchObject({
        status: 409,
        body: { refused: 'hold', message: expect.stringContaining('has no hold waiting now') },
      });
      expect(await answers(workItem)).toEqual([]);
    }
  });

  it('holds a canary’s hold to the release in flight that carries the change, as the line does', async () => {
    const { browser } = await signedIn();
    const release = (name: string) => ({
      release: name,
      version: 'v0.9.5',
      previous: 'v0.9.4',
      watched: true,
      dryRun: false,
    });
    const started = (workItem: string, name: string) =>
      event(workItem, 'release.started', 'rollouts', {
        ...release(name),
        image: { digest: `sha256:${'a'.repeat(64)}`, signed: true, admitted: true },
        steps: null,
      });
    const canary = (workItem: string, name: string) =>
      event(workItem, 'hold.started', 'rollouts', {
        stage: 'release',
        kind: 'held',
        cause: 'canary',
        reason: 'The analysis judged the canary bad',
        release: name,
      });
    const rolledBack = (workItem: string, name: string) =>
      event(workItem, 'release.rolled-back', 'martin', {
        release: name,
        version: 'v0.9.5',
        dryRun: false,
        restored: 'v0.9.4',
        weight: 50,
        reason: 'Judged bad',
        failed: [],
        by: 'martin',
      });
    /** A merged change whose release `first` started, and these events after it, ending with the hold named. */
    const after = async (events: (workItem: string) => NewEvent[]) => {
      const { workItem } = await held('failures');
      const merge = event(workItem, 'pull-request.merged', 'martin', {
        number: 8,
        commit: 'c'.repeat(40),
        by: 'martin',
      });
      const rest = events(workItem);
      await append(db.as.line, [merge, started(workItem, 'first-1'), ...rest]);
      return { workItem, hold: rest.findLast((e) => e.type === 'hold.started')?.id as string };
    };
    // Still held: the end of a release other than the one it holds, promoted or rolled back, ends nothing.
    for (const end of [
      (w: string) => event(w, 'release.promoted', 'rollouts', release('other-2')),
      (w: string) => rolledBack(w, 'other-2'),
    ]) {
      const { workItem, hold } = await after((w) => [canary(w, 'first-1'), end(w)]);
      expect(await browser.post(`/admin/holds/${workItem}/reject`, { hold })).toMatchObject({
        status: 422,
        body: { refused: 'answer' },
      });
      expect(await lineHold(workItem)).toMatchObject({ cause: 'canary' });
    }
    // Ended, or never held: a newer release started; a hold of a release not in flight, or of one promoted already.
    for (const events of [
      (w: string) => [canary(w, 'first-1'), started(w, 'second-2')],
      (w: string) => [canary(w, 'other-2')],
      (w: string) => [event(w, 'release.promoted', 'rollouts', release('first-1')), canary(w, 'first-1')],
      (w: string) => [rolledBack(w, 'first-1'), canary(w, 'first-1')],
    ]) {
      const { workItem, hold } = await after(events);
      expect(await browser.post(`/admin/holds/${workItem}/reject`, { hold })).toMatchObject({
        status: 409,
        body: { refused: 'hold', message: expect.stringContaining('has no hold waiting now') },
      });
      expect(await lineHold(workItem)).toBeUndefined();
    }
  });

  it('asks for the passkey again to approve a guardrail’s hold, decided by the stored cause, and for nothing else', async () => {
    const { browser, passkey } = await signedIn();
    await db.owner`update sessions set stepped_up_at = null where id_sha256 = ${sessionOf(browser)}`;
    for (const cause of GUARDRAIL_HOLDS.filter((cause) => cause !== 'merge')) {
      const { workItem, hold } = await held(cause);
      expect(await browser.post(`/admin/holds/${workItem}/approve`, { hold }), cause).toMatchObject({
        status: 403,
        body: { refused: 'step-up' },
      });
      expect(await answers(workItem)).toEqual([]);
      // Words and a rejection never ask.
      expect((await browser.post(`/admin/holds/${workItem}/answer`, { hold, words: 'Try again' })).status, cause).toBe(
        200,
      );
    }
    const rejected = await held('gates');
    expect((await browser.post(`/admin/holds/${rejected.workItem}/reject`, { hold: rejected.hold })).status).toBe(200);
    // Approving any other cause never asks.
    const question = await held('question', { stage: 'plan' });
    expect((await browser.post(`/admin/holds/${question.workItem}/approve`, { hold: question.hold })).status).toBe(200);
    // Given again, it approves a guardrail's.
    const gates = await held('gates');
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await browser.post(`/admin/holds/${gates.workItem}/approve`, { hold: gates.hold })).status).toBe(200);
    expect(await answers(gates.workItem)).toMatchObject([{ actor: 'martin', payload: { decision: 'approved' } }]);
  });

  it('takes his shared words on a visitor’s report, with the passkey again, as on any other work item', async () => {
    const { browser, passkey } = await signedIn();
    await db.owner`update sessions set stepped_up_at = null where id_sha256 = ${sessionOf(browser)}`;
    const { workItem, hold } = await held('question', { report: true, stage: 'plan' });
    const share = { hold, words: 'Sizes first, then colours', share: true };
    expect(await browser.post(`/admin/holds/${workItem}/answer`, share)).toMatchObject({
      status: 403,
      body: { refused: 'step-up' },
    });
    expect(await answers(workItem)).toEqual([]);
    expect((await stepUp(browser, passkey)).status).toBe(200);
    // Sharing takes words: none is refused, as on any other work item.
    expect(await browser.post(`/admin/holds/${workItem}/answer`, { hold, share: true })).toMatchObject({
      status: 422,
      body: { refused: 'words' },
    });
    const said = await browser.post(`/admin/holds/${workItem}/answer`, share);
    expect(said, JSON.stringify(said.body)).toMatchObject({ status: 200, body: { report: true, shared: true } });
    const [answer] = await answers(workItem);
    expect(answer?.payload).toEqual({
      decision: 'answered',
      answer: 'Sizes first, then colours',
      hold,
      report: true,
      shared: true,
    });
    // Public, through the redactor, as on any other work item.
    expect(answer?.public).toMatchObject({ payload: { answer: 'Sizes first, then colours', shared: true } });
    // On any other work item his words are public anyway: there is nothing to share.
    const plain = await held('question', { stage: 'plan' });
    expect(
      await browser.post(`/admin/holds/${plain.workItem}/answer`, { hold: plain.hold, words: 'Sizes', share: true }),
    ).toMatchObject({ status: 422, body: { refused: 'share' } });
    // Nor is anything but words shared.
    const approve = await held('question', { report: true, stage: 'plan' });
    expect(
      (await browser.post(`/admin/holds/${approve.workItem}/approve`, { hold: approve.hold, share: true })).status,
    ).toBe(400);
  });

  it('asks for the passkey again to approve an improvement’s spec, decided by the stored kind, and no other spec', async () => {
    const { browser, passkey } = await signedIn();
    await db.owner`update sessions set stepped_up_at = null where id_sha256 = ${sessionOf(browser)}`;
    const improvement = async () => {
      const workItem = await nextWorkItem(db.as.triage);
      await append(db.admin, [
        event(workItem, 'work-item.opened', 'martin', { kind: 'improvement', title: 'Delivery dates', sample: false }),
        event(workItem, 'improvement.requested', 'martin', { words: 'Delivery dates.', steppedUp: true }),
      ]);
      const hold = event(workItem, 'hold.started', 'factory', {
        stage: 'plan',
        kind: 'approval',
        cause: 'spec',
        reason: 'An improvement is built only once Martin has approved its spec.',
      });
      await append(db.as.line, [hold]);
      return { workItem, hold: hold.id };
    };
    const asked = await improvement();
    expect(await browser.post(`/admin/holds/${asked.workItem}/approve`, { hold: asked.hold })).toMatchObject({
      status: 403,
      body: { refused: 'step-up' },
    });
    expect(await answers(asked.workItem)).toEqual([]);
    // Words and a rejection never ask.
    const words = await browser.post(`/admin/holds/${asked.workItem}/answer`, {
      hold: asked.hold,
      words: 'Fewer days',
    });
    expect(words.status).toBe(200);
    const rejected = await improvement();
    expect((await browser.post(`/admin/holds/${rejected.workItem}/reject`, { hold: rejected.hold })).status).toBe(200);
    // Another work item's spec never asks.
    const fix = await held('spec', { stage: 'plan' });
    expect((await browser.post(`/admin/holds/${fix.workItem}/approve`, { hold: fix.hold })).status).toBe(200);
    // Given again, it approves an improvement's.
    const approved = await improvement();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await browser.post(`/admin/holds/${approved.workItem}/approve`, { hold: approved.hold })).status).toBe(200);
    expect(await answers(approved.workItem)).toMatchObject([{ actor: 'martin', payload: { decision: 'approved' } }]);
  });

  it('refuses an answer to a spec’s card once the line has written the spec again, saying so', async () => {
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const spec = (outcome: string) => ({
      outcome,
      criteria: [{ given: 'a product', when: 'its page is shown', expect: 'it shows a date' }],
      scope: ['src/pages/product.ts'],
      risks: [],
      rollout: 'Behind its flag',
    });
    const { workItem, hold } = await held('spec', { stage: 'plan' });
    // Another worker's spec is none the line reads: the card still stands.
    await append(db.as.triage, [event(workItem, 'spec.written', 'planner', spec('Not the line’s'))]);
    expect((await browser.post(`/admin/holds/${workItem}/answer`, { hold, words: 'Fewer days' })).status).toBe(200);
    const again = await held('spec', { stage: 'plan' });
    await append(db.as.line, [event(again.workItem, 'spec.written', 'planner', spec('Dates, written again'))]);
    for (const path of ['approve', 'reject'] as const) {
      expect(await browser.post(`/admin/holds/${again.workItem}/${path}`, { hold: again.hold })).toMatchObject({
        status: 409,
        body: {
          refused: 'hold',
          message: `The spec of #${again.workItem} was written again since that card, so this answer would answer nothing: the line holds the new one for you when it needs you.`,
        },
      });
    }
    expect(await answers(again.workItem)).toEqual([]);
    // The line holds the new one, under a hold of its own, which is answered as any other.
    const next = event(again.workItem, 'hold.started', 'factory', {
      stage: 'plan',
      kind: 'approval',
      cause: 'spec',
      reason: 'Held again',
    });
    await append(db.as.line, [next]);
    expect((await browser.post(`/admin/holds/${again.workItem}/approve`, { hold: again.hold })).status).toBe(409);
    expect((await browser.post(`/admin/holds/${again.workItem}/approve`, { hold: next.id })).status).toBe(200);
  });

  it('refuses an answer that would do nothing: approving a merge, a deploy or a suggestion, or words on a deploy', async () => {
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    for (const [cause, path, body] of [
      ['merge', 'approve', {}],
      ['deploy', 'approve', {}],
      ['deploy', 'answer', { words: 'Ship it' }],
      ['suggestion', 'approve', {}],
    ] as const) {
      const { workItem, hold } = await held(cause, { stage: 'release' });
      expect(await browser.post(`/admin/holds/${workItem}/${path}`, { hold, ...body }), cause).toMatchObject({
        status: 422,
        body: { refused: 'answer' },
      });
      expect(await answers(workItem)).toEqual([]);
      expect((await browser.post(`/admin/holds/${workItem}/reject`, { hold })).status, cause).toBe(200);
    }
  });

  it('leaves one of triage’s holds open after words, for his approval or rejection', async () => {
    const { browser } = await signedIn();
    const { workItem, hold } = await held('finding');
    expect(
      (await browser.post(`/admin/holds/${workItem}/answer`, { hold, words: 'Leave it for a sense' })).status,
    ).toBe(200);
    expect((await browser.post(`/admin/holds/${workItem}/answer`, { hold, words: 'Still waiting' })).status).toBe(200);
    expect((await browser.post(`/admin/holds/${workItem}/approve`, { hold })).status).toBe(200);
    expect((await browser.post(`/admin/holds/${workItem}/reject`, { hold })).status).toBe(409);
    expect((await answers(workItem)).map((answer) => answer.payload.decision)).toEqual([
      'answered',
      'answered',
      'approved',
    ]);
  });

  it('takes words on a visitor’s report only shared, exactly as the console offers them, and one Close', async () => {
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    // Unshared words would reach no agent, and none at all would run it again with nothing new: both refused.
    for (const [cause, stage, route] of [
      ['question', 'plan', 'answer'],
      ['gates', 'gates', 'replan'],
      ['review', 'review', 'answer'],
      ['beyond-ticket', 'review', 'answer'],
    ] as const) {
      const { workItem, hold } = await held(cause, { report: true, stage });
      expect(
        await browser.post(`/admin/holds/${workItem}/${route}`, { hold, words: 'Keep them' }),
        cause,
      ).toMatchObject({ status: 422, body: { refused: 'share' } });
      expect(await browser.post(`/admin/holds/${workItem}/${route}`, { hold }), cause).toMatchObject({
        status: 422,
        body: { refused: 'words' },
      });
      expect(await answers(workItem)).toEqual([]);
      // Shared, as the console sends them, they are taken.
      const sent = await browser.post(`/admin/holds/${workItem}/${route}`, { hold, words: 'Keep them', share: true });
      expect(sent.status, cause).toBe(200);
    }
    // Approving a question there carries on, as anywhere: the planner plans again told no answer will come.
    const report = await held('question', { report: true, stage: 'plan' });
    expect((await browser.post(`/admin/holds/${report.workItem}/approve`, { hold: report.hold })).status).toBe(200);
    expect((await answers(report.workItem)).map((answer) => answer.payload)).toEqual([
      { decision: 'approved', hold: report.hold, report: true },
    ]);
    // Triage's holds there keep his words his, unshared: sharing them is refused.
    const suggestion = await held('suggestion', { report: true });
    expect(
      await browser.post(`/admin/holds/${suggestion.workItem}/answer`, {
        hold: suggestion.hold,
        words: 'Keep them',
        share: true,
      }),
    ).toMatchObject({ status: 422, body: { refused: 'share' } });
    // Approving the planner's rejection would close it as Close does: one answer, his rejection, which says he agreed.
    const rejected = await held('ticket-rejected', { report: true, stage: 'plan' });
    expect(await browser.post(`/admin/holds/${rejected.workItem}/approve`, { hold: rejected.hold })).toMatchObject({
      status: 422,
      body: { refused: 'answer' },
    });
    expect((await browser.post(`/admin/holds/${rejected.workItem}/reject`, { hold: rejected.hold })).status).toBe(200);
    expect((await answers(rejected.workItem))[0]?.public).toMatchObject({
      summary: `Martin closed #${rejected.workItem}, agreeing with the planner`,
      payload: { decision: 'rejected' },
    });
    // A report's ticket that names only its page takes his words, shared, or his rejection: approving it would give
    // the planner nothing, and is refused.
    const undescribed = await held('report-undescribed', { report: true, stage: 'plan' });
    const asking = { hold: undescribed.hold };
    for (const [route, body, refused] of [
      ['approve', asking, 'answer'],
      ['replan', { ...asking, words: 'The total', share: true }, 'answer'],
      ['answer', { ...asking, words: 'The total' }, 'share'],
      ['answer', asking, 'words'],
    ] as const) {
      expect(await browser.post(`/admin/holds/${undescribed.workItem}/${route}`, body), route).toMatchObject({
        status: 422,
        body: { refused },
      });
    }
    expect(
      (
        await browser.post(`/admin/holds/${undescribed.workItem}/answer`, {
          ...asking,
          words: 'The total',
          share: true,
        })
      ).status,
    ).toBe(200);
    expect((await answers(undescribed.workItem)).map((answer) => answer.payload)).toEqual([
      { decision: 'answered', answer: 'The total', hold: undescribed.hold, report: true, shared: true },
    ]);
    // On any other work item his words are taken as ever, and needed.
    const elsewhere = await held('review', { stage: 'review' });
    expect(await browser.post(`/admin/holds/${elsewhere.workItem}/answer`, { hold: elsewhere.hold })).toMatchObject({
      status: 422,
      body: { refused: 'words' },
    });
    const plain = await held('question', { stage: 'plan' });
    expect(
      (await browser.post(`/admin/holds/${plain.workItem}/answer`, { hold: plain.hold, words: 'Keep them' })).status,
    ).toBe(200);
  });

  it('keeps his words from the public view on a work item a visitor’s report opened, at any stage', async () => {
    const { browser } = await signedIn();
    for (const cause of ['suggestion', 'finding'] as const) {
      const { workItem, hold } = await held(cause, { report: true, stage: 'plan' });
      const said = await browser.post(`/admin/holds/${workItem}/answer`, { hold, words: 'Search should keep them' });
      expect(said.body).toMatchObject({ report: true });
      const [answer] = await answers(workItem);
      expect(answer?.payload).toEqual({ decision: 'answered', answer: 'Search should keep them', hold, report: true });
      expect(answer?.public).toMatchObject({
        summary: 'Martin answered the hold in words',
        payload: { decision: 'answered', hold, report: true },
      });
      expect(JSON.stringify(answer?.public)).not.toContain('Search should keep them');
      const read = (await readPublic(db.reader, 0)).map(({ event }) => event as { payload?: Body; work_item?: string });
      expect(read.find((e) => e.work_item === workItem && e.payload?.decision)).toBeDefined();
      expect(JSON.stringify(read)).not.toContain('Search should keep them');
    }
  });
});

/**
 * `flags`, as Kubernetes keeps it for the admin service: read, and replaced whole, each write conditional on the
 * `resourceVersion` it names, as the API server makes it. The app's Rollout, when given, answers beside it.
 */
class FlagsKube implements KubeWriter {
  object: Record<string, unknown> = {
    apiVersion: 'core.openfeature.dev/v1beta1',
    kind: 'FeatureFlag',
    metadata: { name: 'flags', namespace: 'flagd', annotations: { 'argocd.argoproj.io/sync-wave': '0' } },
    spec: { flagSpec: { flags: {} } },
  };
  version = 1;
  readonly writes: Record<string, unknown>[] = [];
  /** Answers the next writes with these statuses, in turn, or makes one and loses its answer (`lost`). */
  readonly failing: (number | 'lost' | undefined)[] = [];
  /** How many of the next reads of `flags` fail, as an API server out of reach fails them. */
  failingReads = 0;
  /** Whether a failed write leaves the API out of reach for the next read too. */
  unreadableAfter = false;
  /** Another writer, changing `flags` once just after the admin service reads it. */
  meanwhile: ((flags: Record<string, unknown>) => Record<string, unknown>) | undefined;
  rollout: RolloutKube | undefined;

  get flags(): Record<string, unknown> {
    return (this.object.spec as { flagSpec: { flags: Record<string, unknown> } }).flagSpec.flags;
  }

  set flags(flags: Record<string, unknown>) {
    this.object = { ...this.object, spec: { flagSpec: { flags } } };
    this.version += 1;
  }

  async get<T>(path: string, schema: { parse(v: unknown): T }): Promise<T | undefined> {
    if (path.includes('/rollouts/')) return this.rollout?.get(path, schema);
    if (this.failingReads > 0) {
      this.failingReads -= 1;
      throw new Error('connect ECONNREFUSED');
    }
    const object = this.object as { metadata: object };
    const read = schema.parse({ ...object, metadata: { ...object.metadata, resourceVersion: String(this.version) } });
    const change = this.meanwhile;
    this.meanwhile = undefined;
    if (change) this.flags = change(this.flags);
    return read;
  }

  async replace(path: string, body: unknown): Promise<void> {
    const failing = this.failing.shift();
    if (typeof failing === 'number') {
      if (this.unreadableAfter) this.failingReads = 1;
      throw new KubeError(failing, `PUT ${path} answered ${failing}`);
    }
    const { metadata, ...rest } = body as { metadata: { resourceVersion?: string } };
    if (metadata.resourceVersion !== String(this.version)) throw new KubeError(409, 'the object has been modified');
    const { resourceVersion: _, ...kept } = metadata;
    this.object = { ...rest, metadata: kept };
    this.writes.push(this.object);
    this.version += 1;
    if (failing === 'lost') throw new Error('socket hang up');
  }

  patch = async (path: string, body: unknown) => this.rollout?.patch(path, body);
  text = async () => undefined;
  create = async () => {};
  remove = async () => {};
}

describe('an improvement asked for', () => {
  const requests = () =>
    db.owner<{ seq: string; id: string; work_item: string; type: string; appended_by: string; payload: Body }[]>`
      select seq::text, id, work_item, type, appended_by, payload from events
      where type = 'improvement.requested' or (type = 'work-item.opened' and payload->>'kind' = 'improvement')
      order by seq`;
  const WORDS =
    'Show on each product page when an order placed today would arrive. Count only the days we dispatch on, and ' +
    'say nothing for a product out of stock.';

  it('needs the passkey again, and opens nothing without it', async () => {
    const { browser } = await signedIn();
    const before = (await requests()).length;
    expect(await browser.post('/admin/improvements', { id: crypto.randomUUID(), words: WORDS })).toMatchObject({
      status: 403,
      body: { refused: 'step-up' },
    });
    expect(await requests()).toHaveLength(before);
  });

  it('opens a work item of kind improvement, titled from his first sentence, with his request, in one transaction', async () => {
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const id = crypto.randomUUID();
    const before = (await requests()).length;
    const asked = await browser.post('/admin/improvements', { id, words: `  ${WORDS}  ` });
    const title = 'Show on each product page when an order placed today would…';
    expect(asked).toMatchObject({ status: 200, body: { title } });
    const [opened, request] = (await requests()).slice(before);
    expect(opened).toMatchObject({
      work_item: asked.body.workItem,
      appended_by: 'factory_admin',
      payload: { kind: 'improvement', category: 'improvement', title, sample: false },
    });
    expect(request).toMatchObject({
      id,
      work_item: asked.body.workItem,
      appended_by: 'factory_admin',
      payload: { words: WORDS, steppedUp: true },
    });
    expect(Number(request?.seq)).toBe(Number(opened?.seq) + 1);
    // Numbered by the store, as triage numbers work items.
    expect(Number(asked.body.workItem)).toBeGreaterThanOrEqual(1000);
    const [requested] = await lastEvents(1);
    expect(requested).toMatchObject({ actor: 'martin', summary: `Martin asked for an improvement: ${title}` });
  });

  it('opens one work item for a request sent twice, and refuses the second', async () => {
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const id = crypto.randomUUID();
    const first = await browser.post('/admin/improvements', { id, words: 'Sort products by price.' });
    expect(first.status).toBe(200);
    const before = (await requests()).length;
    expect(await browser.post('/admin/improvements', { id, words: 'Sort products by price.' })).toMatchObject({
      status: 409,
      body: { refused: 'request', message: `That request has been made already: it opened #${first.body.workItem}.` },
    });
    expect(await requests()).toHaveLength(before);
  });

  it('takes his words and the request’s id, and nothing else from the request', async () => {
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const before = (await requests()).length;
    for (const body of [
      {},
      { words: WORDS },
      { id: 'not-an-id', words: WORDS },
      { id: crypto.randomUUID(), words: ' ' },
      { id: crypto.randomUUID(), words: 'x'.repeat(601) },
      { id: crypto.randomUUID(), words: WORDS, kind: 'defect-fix' },
      { id: crypto.randomUUID(), words: WORDS, title: 'Mine' },
    ]) {
      expect(await browser.post('/admin/improvements', body), JSON.stringify(body)).toMatchObject({
        status: 400,
        body: { refused: 'body' },
      });
    }
    expect(await requests()).toHaveLength(before);
    expect(
      (await browser.post('/admin/improvements', { id: crypto.randomUUID(), words: 'x'.repeat(600) })).status,
    ).toBe(200);
  });

  it('shows visitors his words through the redactor', async () => {
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    const words = 'Add a status page. The token is sk-ant-api03-abcdefghijklmnop.';
    expect((await browser.post('/admin/improvements', { id: crypto.randomUUID(), words })).status).toBe(200);
    const [requested] = await lastEvents(1);
    expect(requested?.public).toMatchObject({ payload: { words: 'Add a status page. The token is [redacted].' } });
  });
});

describe('an attack launched', () => {
  const launches = () =>
    db.owner<{ seq: string; work_item: string; type: string; appended_by: string; payload: Body }[]>`
      select seq::text, work_item, type, appended_by, payload from events
      where type = 'attack.launched' or (type = 'work-item.opened' and payload->>'kind' = 'red-team')
      order by seq`;

  /** The harness's end of an attack, appended as its role, or as another's with row security off, as a forgery. */
  const finish = async (workItem: string, as: 'redteam' | 'line' = 'redteam') => {
    const event = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type: 'attack.finished',
      version: VERSIONS['attack.finished'],
      actor: 'red-team',
      summary: 'The attack was not seen to its end',
      payload: { attack: 'egress', outcome: 'unfinished', expected: ['egress-policy'], refusals: [], attempts: [] },
      artifacts: [],
    } as NewEvent;
    const append = () =>
      new EventWriter(as === 'redteam' ? db.redteam : db.as.line, {
        kind: 'real',
        artifacts: new DiskArtifacts('/nonexistent'),
      }).append(event);
    if (as === 'redteam') return append();
    await db.owner`alter table events disable row level security`;
    try {
      return await append();
    } finally {
      await db.owner`alter table events enable row level security`;
    }
  };

  /** Ends whatever attack is under way, so each test launches from none. */
  beforeEach(async () => {
    const [last] = await db.owner<{ work_item: string }[]>`
      select work_item from events l where type = 'attack.launched'
        and not exists (select 1 from events f where f.work_item = l.work_item and f.type = 'attack.finished'
                        and f.appended_by = 'factory_redteam')
      order by seq desc limit 1`;
    if (last) await finish(last.work_item);
    // The catalogue holds every attack back until the harness makes it; the route's rules are tested as if each were
    // available, through the service's seam, which no setting reaches, and its refusal of one held back below.
    await service.stop();
    await start({ attackAvailable: () => true });
  });

  it('needs no passkey again, and opens a work item of kind red-team with his launch, in one transaction', async () => {
    const { browser } = await signedIn();
    const before = (await launches()).length;
    const launched = await browser.post('/admin/attacks/egress', {});
    expect(launched).toMatchObject({ status: 200, body: { attack: 'egress' } });
    const [opened, launch] = (await launches()).slice(before);
    expect(opened).toMatchObject({
      work_item: launched.body.workItem,
      type: 'work-item.opened',
      appended_by: 'factory_admin',
      payload: { kind: 'red-team', category: 'red-team', title: 'Red-team attack by Martin', sample: false },
    });
    expect(launch).toMatchObject({
      work_item: launched.body.workItem,
      type: 'attack.launched',
      appended_by: 'factory_admin',
      payload: { attack: 'egress' },
    });
    expect(Number(launch?.seq)).toBe(Number(opened?.seq) + 1);
    const [event] = await lastEvents(1);
    expect(event).toMatchObject({
      actor: 'martin',
      summary: 'Martin launched an attack: Data to an outside URL',
    });
  });

  it('runs one at a time: refused while the last has neither finished nor passed its limit', async () => {
    const { browser } = await signedIn();
    const first = await browser.post('/admin/attacks/egress', {});
    expect(first.status).toBe(200);
    const before = (await launches()).length;
    expect(await browser.post('/admin/attacks/image', {})).toMatchObject({
      status: 409,
      body: {
        refused: 'attack',
        message: `One attack at a time: #${first.body.workItem} has not finished. Launch another once it has, or in 10 minutes, when it counts as unfinished.`,
      },
    });
    // An end appended by any role but the harness's is none.
    await finish(String(first.body.workItem), 'line');
    expect((await browser.post('/admin/attacks/image', {})).status).toBe(409);
    expect(await launches()).toHaveLength(before);
    // The harness's end lets the next through.
    await finish(String(first.body.workItem));
    expect(await browser.post('/admin/attacks/image', {})).toMatchObject({ status: 200, body: { attack: 'image' } });
  });

  it('lets the next through once the last has passed its limit, by the store’s clock', async () => {
    const { browser } = await signedIn();
    const first = await browser.post('/admin/attacks/report', {});
    expect(first.status).toBe(200);
    await db.owner`alter table events disable trigger user`;
    try {
      await db.owner`update events set appended_at = appended_at - interval '19 minutes'
                     where work_item = ${String(first.body.workItem)}`;
      expect(await browser.post('/admin/attacks/egress', {})).toMatchObject({
        status: 409,
        body: { message: expect.stringContaining('or in a minute, when it counts as unfinished') },
      });
      await db.owner`update events set appended_at = appended_at - interval '1 minute'
                     where work_item = ${String(first.body.workItem)}`;
    } finally {
      await db.owner`alter table events enable trigger user`;
    }
    expect(await browser.post('/admin/attacks/egress', {})).toMatchObject({ status: 200, body: { attack: 'egress' } });
  });

  it('refuses an attack not available yet, having appended nothing', async () => {
    // The catalogue makes every attack available now, since the harness and the GitHub worker's door make all five;
    // the route's refusal of one not available is tested through the service's seam, which a later version would use
    // to stage a new attack before its attempt is built.
    expect(ATTACKS.every((attack) => attackAvailable(attack))).toBe(true);
    await service.stop();
    await start({ attackAvailable: (attack) => attack !== 'egress' });
    const { browser } = await signedIn();
    const before = (await launches()).length;
    expect(await browser.post('/admin/attacks/egress', {})).toMatchObject({
      status: 403,
      body: { refused: 'attack', message: 'This attack is not available yet.' },
    });
    expect(await launches()).toHaveLength(before);
  });

  it('waits out a launch already recorded of an attack held back since, for its own limit', async () => {
    const held = 'test';
    await service.stop();
    await start({ attackAvailable: (attack) => attack !== held });
    const { browser } = await signedIn();
    expect(await browser.post(`/admin/attacks/${held}`, {})).toMatchObject({ status: 403 });
    const workItem = await nextWorkItem(db.admin);
    const event = (type: string, payload: object) =>
      ({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        work_item: workItem,
        type,
        version: VERSIONS[type as keyof typeof VERSIONS],
        actor: 'martin',
        summary: `${type} for the test`,
        payload,
        artifacts: [],
      }) as NewEvent;
    await new EventWriter(db.admin, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }).append([
      event('work-item.opened', {
        kind: 'red-team',
        category: 'red-team',
        title: 'Red-team attack by Martin',
        sample: false,
      }),
      event('attack.launched', { attack: held }),
    ]);
    const minutes = ATTACK_RULES[held].minutes;
    expect(await browser.post('/admin/attacks/egress', {})).toMatchObject({
      status: 409,
      body: { message: expect.stringContaining(`#${workItem} has not finished`) },
    });
    expect(await browser.post('/admin/attacks/egress', {})).toMatchObject({
      body: { message: expect.stringContaining(`or in ${minutes} minutes`) },
    });
  });

  it('counts a sample’s end in a store of samples, as Martin’s command line records one', async () => {
    const samples = await freshDatabase('attack_samples');
    try {
      const append = (sql: Sql, workItem: string, type: string, version: number, payload: object) => sql`
        insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
        values (${crypto.randomUUID()}, now(), ${workItem}, ${type}, ${version}, 'martin', 'A sample',
                ${sql.json(payload as never)}, '[]', '{}', true)`;
      await append(samples.operator, '1293', 'attack.launched', 2, { attack: 'image' });
      expect(await samples.admin.begin((tx) => lastLaunch(tx))).toMatchObject({ workItem: '1293', finished: false });
      await append(samples.operator, '1293', 'attack.finished', 1, { attack: 'image', outcome: 'refused' });
      expect(await samples.admin.begin((tx) => lastLaunch(tx))).toMatchObject({ workItem: '1293', finished: true });
    } finally {
      await samples.end();
    }
  });

  it('takes one of the five attacks, by its id, and nothing from the body', async () => {
    const { browser } = await signedIn();
    const before = (await launches()).length;
    expect(await browser.post('/admin/attacks/rm-rf', {})).toMatchObject({ status: 404, body: { refused: 'attack' } });
    for (const body of [{ attack: 'egress' }, { kind: 'defect-fix' }, { title: 'Mine' }]) {
      expect(await browser.post('/admin/attacks/egress', body), JSON.stringify(body)).toMatchObject({
        status: 400,
        body: { refused: 'body' },
      });
    }
    expect(await launches()).toHaveLength(before);
  });
});

describe('the flags’ stages', () => {
  const FLAGS = { namespace: 'flagd', name: 'flags' };
  const ROLLOUT = { namespace: 'website', name: 'website' };
  const event = (workItem: string | null, type: string, actor: string, payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type as keyof typeof VERSIONS],
      actor,
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    }) as NewEvent;
  const append = (sql: Sql, events: NewEvent[]) =>
    new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }).append(events);

  // Events are append-only, so each test's flag is a flag of its own.
  let n = 0;
  let FLAG = 'delivery-dates-0';
  let kube: FlagsKube;

  /**
   * An improvement whose spec names the flag, as Martin asks for it and the line records the planner's spec, and
   * Verify's run of it with the flag off, which Checks waits for, unless told there is none yet.
   */
  async function improvement(flag: string, kind = 'improvement', baseline = true): Promise<string> {
    const workItem = await nextWorkItem(db.as.triage);
    // Martin's improvement, as the admin service opens it with his request; any other kind, as a worker opens it.
    const improving = kind === 'improvement';
    await append(improving ? db.admin : db.as.triage, [
      event(workItem, 'work-item.opened', 'martin', { kind, title: 'Delivery dates', sample: false }),
      ...(improving ? [event(workItem, 'improvement.requested', 'martin', { words: 'Dates.', steppedUp: true })] : []),
    ]);
    await append(db.as.line, [
      event(workItem, 'spec.written', 'planner', {
        outcome: 'Each product says when it would arrive',
        criteria: [{ given: 'a product page', when: 'it is shown', expect: 'it says when it would arrive' }],
        scope: ['src/pages/product.ts'],
        risks: [],
        rollout: 'Behind its flag',
        flag,
      }),
    ]);
    if (baseline) await baselineOf(workItem, flag);
    return workItem;
  }

  /** Verify's run of the flag with it off, as the line appends it, or as another role would, with the pages it took. */
  const baselineOf = (
    workItem: string,
    flag = FLAG,
    sql = db.as.line,
    pages: Extract<PayloadOf<'flag.checked'>, { stage: 'off' }>['pages'] = [],
  ) =>
    append(sql, [
      event(workItem, 'flag.checked', 'factory', {
        stage: 'off',
        flag,
        version: 'v0.9.5',
        revision: 'none',
        journeys: { passed: 24, ran: 24 },
        notClean: [],
        pages,
      }),
    ]);

  /** The revision Martin's latest move of a flag wrote, which Verify's judgement of it names. */
  const lastMove = async (flag = FLAG) => {
    const [row] = await db.owner<{ revision: string }[]>`
      select payload->>'revision' as revision from events
      where type = 'flag.staged' and payload->>'flag' = ${flag} order by seq desc limit 1`;
    return row?.revision ?? 'none';
  };

  /** Verify's comparison of the flag at a share, as the line appends it, or as another role would. */
  const compared = async (workItem: string, share: number, outcome: 'passed' | 'failed', sql = db.as.line) =>
    append(sql, [
      event(workItem, 'flag.compared', 'factory', {
        flag: FLAG,
        share,
        moveRevision: await lastMove(),
        window: { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString() },
        setAsideMinutes: 0,
        outcome,
        sides: { on: { requests: 900, errorRate: 0, p99Ms: 140 }, off: { requests: 880, errorRate: 0, p99Ms: 135 } },
      }),
    ]);

  /** Verify's check of the flag with the probes at Checks or Preview, as the line appends it, or as another role would. */
  const checked = async (
    workItem: string,
    stage: 'checks' | 'preview',
    outcome: 'passed' | 'failed' | 'unsure',
    { sql = db.as.line, flag = FLAG, moveRevision = undefined as string | undefined } = {},
  ) =>
    append(sql, [
      event(workItem, 'flag.checked', 'factory', {
        stage,
        flag,
        version: 'v0.9.5',
        revision: 'r1',
        moveRevision: moveRevision ?? (await lastMove(flag)),
        against: 'v0.9.5',
        outcome,
        journeys: { base: { passed: 24, ran: 24 }, change: { passed: 24, ran: 24 } },
        regressions: [],
        ...(stage === 'checks' ? { pages: [] } : { device: { allowed: ['cookie preview'], kept: [] } }),
      }),
    ]);

  const move = (browser: Browser, from: object | null, to: object, more: Body = {}, flag = FLAG) =>
    browser.post(`/admin/flags/${flag}/stage`, { from, to, ...more });

  const staged = () =>
    db.owner<{ work_item: string; actor: string; appended_by: string; summary: string; payload: Body; public: Body }[]>`
      select work_item, actor, appended_by, summary, payload, public from events
      where type = 'flag.staged' and payload->>'flag' = ${FLAG} order by seq`;

  /** The stage `flags` holds the flag at, read back through the module. */
  const held = (flag = FLAG) => readFlags(kube.object.spec).stages[flag];

  /** The service, with `flags` empty, and the app's Rollout in this state (none: not there): by default, no canary out. */
  const withFlags = async (
    rollout: RolloutKube | null = new RolloutKube({ current: STABLE, stable: STABLE, revision: 7 }),
    config: Partial<AdminConfig> = { flags: FLAGS, rollout: ROLLOUT },
    held: FlagsHeld | false = false,
  ) => {
    kube = new FlagsKube();
    kube.rollout = rollout ?? undefined;
    await service.stop();
    await start(config, kube, held);
  };

  beforeEach(async () => {
    n += 1;
    FLAG = `delivery-dates-${n}`;
    await withFlags();
  });

  const off = { stage: 'off' };
  const checks = { stage: 'checks' };
  const preview = { stage: 'preview' };
  const share = (s: number) => ({ stage: 'share', share: s });
  const everyone = { stage: 'everyone' };

  it('widens to Checks with no passkey, writes the flag set with a new revision, and records it as Martin’s', async () => {
    const workItem = await improvement(FLAG);
    const { browser } = await signedIn();
    const res = await move(browser, off, checks);
    expect(res, JSON.stringify(res.body)).toMatchObject({
      status: 200,
      body: { staged: { flag: FLAG, from: off, to: checks, action: 'flag.to-checks', revision: 'r1' } },
    });
    expect(held()).toEqual(checks);
    expect(readFlags(kube.object.spec).revision).toBe('r1');
    // A name longer than the events take is no flag of the app's.
    expect(await move(browser, off, checks, {}, 'a'.repeat(101))).toMatchObject({ status: 404 });
    // The rest of `flags` is as it was read.
    expect((kube.object.metadata as Body).annotations).toEqual({ 'argocd.argoproj.io/sync-wave': '0' });
    const [recorded] = await staged();
    expect(recorded).toMatchObject({
      work_item: workItem,
      actor: 'martin',
      appended_by: 'factory_admin',
      summary: `Martin widened ${FLAG} from Off to Checks`,
      payload: { flag: FLAG, from: off, to: checks, revision: 'r1', steppedUp: false },
    });
    expect(recorded?.public).toMatchObject({ payload: recorded?.payload });
    // To where it is already: nothing written, nothing recorded.
    expect(await move(browser, checks, checks)).toMatchObject({ status: 200, body: { staged: null } });
    expect(await move(browser, off, off, {}, `${FLAG}-never-on`)).toMatchObject({
      status: 200,
      body: { staged: null },
    });
    expect(kube.writes).toHaveLength(1);
    expect(await staged()).toHaveLength(1);
  });

  it('asks for the passkey again to widen past Checks and to turn back on, and never to narrow or turn off', async () => {
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await move(browser, off, checks)).status).toBe(200);
    await checked(workItem, 'checks', 'passed');
    expect(await move(browser, checks, share(50))).toMatchObject({ status: 403, body: { refused: 'step-up' } });
    expect(held()).toEqual(checks);
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, checks, share(50))).status).toBe(200);
    await compared(workItem, 50, 'passed');
    expect((await move(browser, share(50), everyone)).status).toBe(200);

    // The passkey gone stale: narrowing and turning off still go ahead; turning back on does not.
    await db.owner`update sessions set stepped_up_at = now() - interval '6 minutes' where id_sha256 = ${sessionOf(browser)}`;
    expect(await move(browser, everyone, off)).toMatchObject({ status: 400, body: { refused: 'body' } });
    expect((await move(browser, everyone, off, { reason: 'Dates are wrong on sale items' })).status).toBe(200);
    expect(await move(browser, off, everyone)).toMatchObject({ status: 403, body: { refused: 'step-up' } });
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await move(browser, off, everyone)).toMatchObject({
      status: 200,
      body: { staged: { action: 'flag.back-on', revision: 'r5' } },
    });
    await db.owner`update sessions set stepped_up_at = now() - interval '6 minutes' where id_sha256 = ${sessionOf(browser)}`;
    expect((await move(browser, everyone, preview)).status).toBe(200);

    expect((await staged()).map((e) => [e.summary, e.payload.steppedUp, e.payload.reason])).toEqual([
      [`Martin widened ${FLAG} from Off to Checks`, false, undefined],
      [`Martin widened ${FLAG} from Checks to Share 50%`, true, undefined],
      [`Martin widened ${FLAG} from Share 50% to Everyone`, true, undefined],
      [`Martin turned ${FLAG} off, from Everyone`, false, 'Dates are wrong on sale items'],
      [`Martin turned ${FLAG} back on for everyone`, true, undefined],
      [`Martin narrowed ${FLAG} from Everyone to Preview`, false, undefined],
    ]);
  });

  it('refuses a skipped stage but Preview, and turning back on a flag not turned off from Everyone', async () => {
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    for (const to of [preview, share(50), everyone]) {
      expect(await move(browser, off, to), JSON.stringify(to)).toMatchObject({
        status: 409,
        body: { refused: 'stage' },
      });
    }
    expect((await move(browser, off, checks)).status).toBe(200);
    await checked(workItem, 'checks', 'passed');
    expect((await move(browser, checks, everyone)).body.message).toMatch(/stage at a time/);
    expect((await move(browser, checks, share(30))).body.message).toBe('A share is 10, 25 or 50%.');
    expect((await move(browser, checks, share(25))).status).toBe(200);
    expect((await move(browser, share(25), off, { reason: 'Not yet' })).status).toBe(200);
    expect((await move(browser, off, everyone)).body.message).toMatch(/Only a flag turned off from Everyone/);
    expect(held()).toEqual(off);
  });

  it('refuses Everyone until the line’s comparison at the flag’s share since its last move has passed', async () => {
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, off, checks)).status).toBe(200);
    await checked(workItem, 'checks', 'passed');
    expect((await move(browser, checks, share(50))).status).toBe(200);
    expect((await move(browser, share(50), everyone)).body.message).toMatch(/still comparing/);
    // A comparison any other role appended is no comparison of Verify's.
    await compared(workItem, 50, 'passed', db.as.triage);
    expect((await move(browser, share(50), everyone)).body.message).toMatch(/still comparing/);
    await compared(workItem, 50, 'failed');
    expect((await move(browser, share(50), everyone)).body.message).toMatch(/failed/);
    await compared(workItem, 50, 'passed');
    // Moved since, the comparison is of the flag as it was.
    expect((await move(browser, share(50), share(25))).status).toBe(200);
    expect((await move(browser, share(25), everyone)).body.message).toMatch(/still comparing/);
    await compared(workItem, 25, 'passed');
    expect((await move(browser, share(25), everyone)).status).toBe(200);
  });

  it('refuses a widening past Checks or Preview until the line’s check there since its last move has passed', async () => {
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, off, checks)).status).toBe(200);
    expect(await move(browser, checks, preview)).toMatchObject({
      status: 409,
      body: { refused: 'stage', message: expect.stringMatching(/still checking the flag at Checks/) },
    });
    // A check any other role appended is no check of Verify's, nor one that names another move.
    await checked(workItem, 'checks', 'passed', { sql: db.as.triage });
    expect((await move(browser, checks, share(50))).body.message).toMatch(/still checking/);
    await checked(workItem, 'checks', 'passed', { moveRevision: 'r0' });
    expect((await move(browser, checks, share(50))).body.message).toMatch(/still checking/);
    await checked(workItem, 'checks', 'unsure');
    expect((await move(browser, checks, share(50))).body.message).toMatch(/at Checks could not tell/);
    await checked(workItem, 'checks', 'failed');
    expect((await move(browser, checks, preview)).body.message).toMatch(/at Checks failed/);
    await checked(workItem, 'checks', 'passed');
    expect((await move(browser, checks, preview)).status).toBe(200);
    // Moved since, the check at Checks is of the flag as it was: Preview is checked in its own right.
    expect((await move(browser, preview, share(50))).body.message).toMatch(/still checking the flag at Preview/);
    await checked(workItem, 'preview', 'failed');
    expect((await move(browser, preview, share(50))).body.message).toMatch(/at Preview failed/);
    // Narrowing is never held by it.
    expect((await move(browser, preview, checks)).status).toBe(200);
    expect((await move(browser, checks, preview)).body.message).toMatch(/still checking the flag at Checks/);
    await checked(workItem, 'checks', 'passed');
    expect((await move(browser, checks, preview)).status).toBe(200);
    await checked(workItem, 'preview', 'passed');
    expect((await move(browser, preview, share(50))).status).toBe(200);
  });

  it('refuses Checks until the line has taken a run of the flag off for the improvement', async () => {
    const workItem = await improvement(FLAG, 'improvement', false);
    const { browser } = await signedIn();
    expect(await move(browser, off, checks)).toMatchObject({
      status: 409,
      body: { refused: 'stage', message: expect.stringMatching(/^Verify has no picture of the app with the flag off/) },
    });
    // Another role's is none of Verify's; the line's lets Checks be taken.
    await baselineOf(workItem, FLAG, db.as.triage);
    expect((await move(browser, off, checks)).status).toBe(409);
    await baselineOf(workItem);
    expect((await move(browser, off, checks)).status).toBe(200);
  });

  it('refuses Checks on a baseline missing a page in either colour scheme, as one taken before dark was', async () => {
    const workItem = await improvement(FLAG, 'improvement', false);
    const { browser } = await signedIn();
    const light = { page: '/', route: '/', scheme: 'light', off: '1'.repeat(64) } as const;
    // As the store reads one taken before Verify named a scheme: its page read as light, and no dark.
    const v2 = {
      stage: 'off',
      flag: FLAG,
      version: 'v0.9.5',
      revision: 'none',
      journeys: { passed: 24, ran: 24 },
      notClean: [],
      pages: [{ page: '/', route: '/', off: '1'.repeat(64) }],
    };
    // Stored as the line stored it then: the writer takes only the current version now.
    await db.as.line`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
      values (${crypto.randomUUID()}, now(), ${workItem}, 'flag.checked', 2, 'factory', 'flag.checked for the test',
              ${db.as.line.json(v2)}, '[]', '{}', false)`;
    expect(await move(browser, off, checks)).toMatchObject({
      status: 409,
      body: {
        message: expect.stringMatching(/^Verify has no picture of the app with the flag off, in light and dark/),
      },
    });
    await baselineOf(workItem, FLAG, db.as.line, [light]);
    expect((await move(browser, off, checks)).status).toBe(409);
    await baselineOf(workItem, FLAG, db.as.line, [light, { ...light, scheme: 'dark', off: '2'.repeat(64) }]);
    expect((await move(browser, off, checks)).status).toBe(200);
  });

  it('refuses Share while a canary is in flight, or that can’t be told, or another flag is at Share', async () => {
    await improvement(FLAG);
    const other = await improvement(`${FLAG}-other`);
    expect(other).toBeTruthy();
    await withFlags(new RolloutKube({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25, revision: 40 }));
    kube.flags = flagsSpec({ [FLAG]: { stage: 'checks' } }, 'r1').flagSpec.flags;
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, checks, share(50))).body.message).toMatch(
      /is at 25%, and its two versions would mix the two sides\. Share can be taken once it ends\.$/,
    );
    // With no Rollout to read, or none named, whether a canary is in flight can't be told.
    for (const config of [{ flags: FLAGS }, { flags: FLAGS, rollout: ROLLOUT }]) {
      await withFlags(null, config);
      kube.flags = flagsSpec({ [FLAG]: { stage: 'checks' } }, 'r1').flagSpec.flags;
      expect((await move(browser, checks, share(50))).body.message).toMatch(/can't be told/);
    }
    // A canary-free cluster, and another flag at Share.
    await withFlags();
    kube.flags = flagsSpec(
      { [FLAG]: { stage: 'checks' }, [`${FLAG}-other`]: { stage: 'share', share: 10 } },
      'r1',
    ).flagSpec.flags;
    expect((await move(browser, checks, share(50))).body.message).toBe(
      `${FLAG}-other is at Share: one flag at a time, so each comparison varies one thing.`,
    );
    expect(held()).toEqual(checks);
    expect(await staged()).toEqual([]);
  });

  it('refuses a flag no improvement’s spec names, and a move from a stage other than the one `flags` holds', async () => {
    await improvement(FLAG, 'defect-fix');
    const { browser } = await signedIn();
    expect((await move(browser, off, checks)).body.message).toMatch(/No improvement's spec names/);
    expect((await move(browser, off, checks, {}, 'never-specced')).body.message).toMatch(/No improvement's spec/);
    expect(await move(browser, off, checks, {}, 'flag-set-revision')).toMatchObject({ status: 404 });
    expect(await move(browser, off, checks, {}, 'Not_A_Flag')).toMatchObject({ status: 404 });
    await improvement(FLAG);
    expect(await move(browser, checks, preview)).toMatchObject({ status: 409, body: { refused: 'flag' } });
    expect((await move(browser, checks, preview)).body.message).toBe(`${FLAG} is at Off now, not Checks: look again.`);
    expect(await move(browser, off, { stage: 'nowhere' })).toMatchObject({ status: 400 });
    expect(kube.writes).toEqual([]);
  });

  it('keeps every other flag at its stage, drops one in no stage’s shape, and counts the revision on', async () => {
    await improvement(FLAG);
    kube.flags = {
      ...flagsSpec({ 'price-sort': { stage: 'preview' } }, 'r7').flagSpec.flags,
      'by-hand': {
        state: 'ENABLED',
        variants: { on: true, off: false },
        defaultVariant: 'off',
        targeting: { if: [{ '==': [{ var: 'email' }, 'martin@example.com'] }, 'on', 'off'] },
      },
    };
    const { browser } = await signedIn();
    expect(await move(browser, off, checks)).toMatchObject({
      status: 200,
      body: { staged: { revision: 'r8' }, dropped: ['by-hand'] },
    });
    // The move that dropped it says so, for Martin and the audit log.
    expect((await staged()).map((e) => [e.summary, e.payload.dropped])).toEqual([
      [`Martin widened ${FLAG} from Off to Checks, and dropped 1 set by hand`, ['by-hand']],
    ]);
    expect(readFlags(kube.object.spec)).toEqual({
      stages: { 'price-sort': { stage: 'preview' }, [FLAG]: { stage: 'checks' } },
      revision: 'r8',
      outside: [],
    });
  });

  it('reads `flags` again and judges again when it changed meanwhile, so two moves at once lose neither', async () => {
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, off, checks)).status).toBe(200);
    await checked(workItem, 'checks', 'passed');
    // Another tab puts another flag at Share between this move's read and its write.
    kube.meanwhile = (flags) => ({
      ...flags,
      ...flagsSpec({ 'price-sort': { stage: 'share', share: 50 } }, 'r2').flagSpec.flags,
    });
    expect((await move(browser, checks, share(50))).body.message).toMatch(/price-sort is at Share/);
    kube.meanwhile = (flags) => ({ ...flags, ...flagsSpec({ 'price-sort': { stage: 'off' } }, 'r3').flagSpec.flags });
    expect((await move(browser, checks, preview)).status).toBe(200);
    expect(readFlags(kube.object.spec).stages).toEqual({
      'price-sort': { stage: 'off' },
      [FLAG]: { stage: 'preview' },
    });
  });

  it('records nothing when Kubernetes refuses the write, and counts a write whose answer was lost as made', async () => {
    await improvement(FLAG);
    const { browser } = await signedIn();
    kube.failing.push(403);
    expect(await move(browser, off, checks)).toMatchObject({ status: 502, body: { refused: 'kubernetes' } });
    expect(await staged()).toEqual([]);
    kube.failing.push('lost');
    expect((await move(browser, off, checks)).status).toBe(200);
    expect(held()).toEqual(checks);
    expect(await staged()).toHaveLength(1);
  });

  it('turns off a flag staged before, once no spec names it, on the work item it was staged on', async () => {
    const workItem = await improvement(FLAG);
    const { browser } = await signedIn();
    expect((await move(browser, off, checks)).status).toBe(200);
    // The planner's next spec renames the flag.
    await append(db.as.line, [
      event(workItem, 'spec.written', 'planner', {
        outcome: 'Each product says when it would arrive',
        criteria: [{ given: 'a product page', when: 'it is shown', expect: 'it says when it would arrive' }],
        scope: ['src/pages/product.ts'],
        risks: [],
        rollout: 'Behind its flag',
        flag: `${FLAG}-renamed`,
      }),
    ]);
    expect((await move(browser, checks, preview)).body.message).toMatch(/No improvement's spec names/);
    expect((await move(browser, checks, off, { reason: 'Renamed' })).status).toBe(200);
    expect((await staged()).map((e) => [e.work_item, e.payload.action])).toEqual([
      [workItem, 'flag.to-checks'],
      [workItem, 'flag.off'],
    ]);
  });

  it('turns back on from Everyone a flag turned off and closed, and widens none other, closed or not yet', async () => {
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, off, checks)).status).toBe(200);
    await checked(workItem, 'checks', 'passed');
    expect((await move(browser, checks, share(50))).status).toBe(200);
    await compared(workItem, 50, 'passed');
    expect((await move(browser, share(50), everyone)).status).toBe(200);
    expect((await move(browser, everyone, off, { reason: 'Wrong on Sundays' })).status).toBe(200);
    // Before the line's pass closes it, it stays off already.
    expect((await move(browser, off, checks)).body.message).toMatch(/, and stays off, its code in the app/);
    // The line closes it as turned off, as its pass does.
    const closed = (item: string, reason: string) =>
      append(db.as.line, [event(item, 'work-item.closed', 'factory', { outcome: 'turned-off', reason })]);
    await closed(workItem, 'Wrong on Sundays');
    expect((await move(browser, off, checks)).body.message).toMatch(/, and stays off, its code in the app/);
    // Straight back on, recorded on the closed work item; then off again.
    expect(await move(browser, off, everyone)).toMatchObject({
      status: 200,
      body: { staged: { action: 'flag.back-on' } },
    });
    expect((await move(browser, everyone, off, { reason: 'Still wrong' })).status).toBe(200);
    expect((await staged()).slice(-2).map((e) => [e.work_item, e.payload.action])).toEqual([
      [workItem, 'flag.back-on'],
      [workItem, 'flag.off'],
    ]);

    // One turned off from Preview, and closed, stays off.
    const flag = `${FLAG}-preview`;
    const other = await improvement(flag);
    expect((await move(browser, off, checks, {}, flag)).status).toBe(200);
    await checked(other, 'checks', 'passed', { flag });
    expect((await move(browser, checks, preview, {}, flag)).status).toBe(200);
    expect((await move(browser, preview, off, { reason: 'Not wanted' }, flag)).status).toBe(200);
    await closed(other, 'Not wanted');
    expect(await move(browser, off, checks, {}, flag)).toMatchObject({
      status: 409,
      body: { message: expect.stringMatching(/, and stays off, its code in the app/) },
    });
    expect(await move(browser, off, everyone, {}, flag)).toMatchObject({
      status: 409,
      body: { message: expect.stringMatching(/Only a flag turned off from Everyone/) },
    });
  });

  it('keeps a flag Martin’s once the line closes its improvement as verified at Everyone: off, and back on', async () => {
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, off, checks)).status).toBe(200);
    await checked(workItem, 'checks', 'passed');
    expect((await move(browser, checks, share(50))).status).toBe(200);
    await compared(workItem, 50, 'passed');
    expect((await move(browser, share(50), everyone)).status).toBe(200);
    // The line closes it as verified, as its pass does once the app has had its minute.
    await append(db.as.line, [
      event(workItem, 'work-item.closed', 'factory', {
        outcome: 'verified',
        reason: `Martin widened ${FLAG} to Everyone, after Verify's comparison at Share passed`,
      }),
    ]);
    expect((await move(browser, everyone, off, { reason: 'Wrong on Sundays' })).status).toBe(200);
    expect((await move(browser, off, checks)).body.message).toMatch(/, and stays off, its code in the app/);
    expect(await move(browser, off, everyone)).toMatchObject({
      status: 200,
      body: { staged: { action: 'flag.back-on' } },
    });
    expect((await staged()).slice(-2).map((e) => [e.work_item, e.payload.action])).toEqual([
      [workItem, 'flag.off'],
      [workItem, 'flag.back-on'],
    ]);
  });

  it('has the app asked soon after each write, and a narrowing, Off or a flag dropped start the minute it has', async () => {
    /** The check of the flags the app holds, as the stages tell it of each write. */
    class Told {
      readonly narrowed: boolean[] = [];
      written(narrowed: boolean) {
        this.narrowed.push(narrowed);
      }
      start() {}
      async stop() {}
      figures() {
        return undefined;
      }
    }
    const told = new Told();
    await withFlags(undefined, undefined, told as unknown as FlagsHeld);
    const workItem = await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect((await move(browser, off, checks)).status).toBe(200);
    await checked(workItem, 'checks', 'passed');
    expect((await move(browser, checks, share(50))).status).toBe(200);
    expect((await move(browser, share(50), share(10))).status).toBe(200);
    // Refused, or to where it is already: nothing written, nothing told.
    expect((await move(browser, share(10), everyone)).status).toBe(409);
    expect((await move(browser, share(10), share(10))).status).toBe(200);
    expect((await move(browser, share(10), off, { reason: 'Dates are wrong' })).status).toBe(200);
    // A widening that drops a flag in no stage's shape turns that one off (of another flag: this one stays off).
    await improvement(`${FLAG}-next`);
    kube.flags = { ...kube.flags, 'by-hand': { state: 'ENABLED', variants: { on: true }, defaultVariant: 'on' } };
    expect((await move(browser, off, checks, {}, `${FLAG}-next`)).body).toMatchObject({ dropped: ['by-hand'] });
    expect(told.narrowed).toEqual([false, false, true, true, true]);
  });

  it('turns a flag off from the stage `flags` holds, whatever the slider showed, and holds every other move to it', async () => {
    await improvement(FLAG);
    const { browser, passkey } = await signedIn();
    expect((await move(browser, off, checks)).status).toBe(200);
    // A move made and never recorded: `flags` holds Preview, and the events still say Checks.
    kube.flags = flagsSpec({ [FLAG]: { stage: 'preview' } }, 'r9').flagSpec.flags;
    expect((await stepUp(browser, passkey)).status).toBe(200);
    expect(await move(browser, checks, share(50))).toMatchObject({ status: 409, body: { refused: 'flag' } });
    expect((await move(browser, checks, off, { reason: 'Something is wrong' })).status).toBe(200);
    expect(held()).toEqual(off);
    expect((await staged()).at(-1)?.payload).toMatchObject({ from: preview, to: off, action: 'flag.off' });
  });

  it('answers a write that failed as not made, and one it cannot read back as not known', async () => {
    await improvement(FLAG);
    const { browser } = await signedIn();
    kube.failing.push(503);
    expect(await move(browser, off, checks)).toMatchObject({ status: 502, body: { refused: 'kubernetes' } });
    // Failed, and the API out of reach for the read back after it.
    kube.failing.push(503);
    kube.unreadableAfter = true;
    const res = await move(browser, off, checks);
    expect(res).toMatchObject({ status: 504, body: { refused: 'kubernetes' } });
    expect(res.body.message).toMatch(/can't be told/);
    expect(held()).toBeUndefined();
    expect(await staged()).toEqual([]);
  });

  it('starts the revision from the time when `flags` holds flags but no revision it can read', () => {
    expect(nextRevision(undefined, 1_761_500_000_000, true)).toBe('r1');
    expect(nextRevision(undefined, 1_761_500_000_000)).toBe('r1761500000000');
    expect(nextRevision('2026-10-26', 1_761_500_000_000)).toBe('r1761500000000');
    expect(nextRevision('r41')).toBe('r42');
  });

  it('refuses every move when the admin service has no flags to stage', async () => {
    await improvement(FLAG);
    await withFlags(null, {});
    const { browser } = await signedIn();
    expect(await move(browser, off, checks)).toMatchObject({ status: 503, body: { refused: 'flags' } });
  });
});

describe('whether the app holds the flags as set', () => {
  /** Kubernetes that cannot be read: the check finds no pod to ask. */
  const unread: KubeWriter = {
    get: async () => {
      throw new KubeError(403, 'forbidden');
    },
    text: async () => undefined,
    create: async () => {},
    remove: async () => {},
    patch: async () => {},
    replace: async () => {},
  };

  it('is anyone’s to read, as last checked, without a session or the console’s origin, and never stored', async () => {
    const held = new FlagsHeld({
      kube: unread,
      flags: { namespace: 'flagd', name: 'flags' },
      rollout: { namespace: 'website', name: 'website' },
      log: pino({ level: 'silent' }),
    });
    await service.stop();
    await start({}, undefined, held);
    // The check the service starts with.
    await expect.poll(() => held.view().checkedAt).not.toBeNull();
    const res = await fetch(`${base}/admin/flags/held`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(held.view());
    expect(held.view()).toMatchObject({ state: 'unchecked', revision: null, held: [] });
    expect((await fetch(`${base}/admin/flags/held`, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(`${base}/admin/flags/held`, { method: 'POST' })).status).toBe(404);
  });

  it('says so when the service does not check them', async () => {
    const res = await fetch(`${base}/admin/flags/held`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ refused: 'flags', message: 'The admin service does not check the flags.' });
  });
});

describe('forwarded headers', () => {
  const tries = async (forwardedFor: (i: number) => string) => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await new Browser().post(
        '/admin/sign-in/options',
        {},
        { headers: { 'x-forwarded-for': forwardedFor(i) } },
      );
      statuses.push(res.status);
    }
    return statuses;
  };

  it('are ignored from anywhere but the proxy in front: the limit counts the connection', async () => {
    const statuses = await tries((i) => `203.0.113.${i}`);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('are believed from the proxy, for the address it saw', async () => {
    await service.stop();
    await start({ trusted: proxies('127.0.0.1, ::1') });
    // Each from an address of its own, as the proxy says: none is limited.
    expect((await tries((i) => `203.0.113.${i}`)).every((s) => s === 200)).toBe(true);
    // What the client wrote to the left of the proxy's own entry is not believed.
    const spoofed = await tries((i) => `198.51.100.${i}, 192.0.2.1`);
    expect(spoofed[30]).toBe(429);
  });
});

describe('factory admin enrol', () => {
  it('prints a code of 128 random bits, which the store keeps the hash of', async () => {
    const made = await enrol(db.enrol);
    expect(made.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(
      await db.owner`select 1 from enrolment_codes where code_sha256 = ${sha256(made.code.replaceAll('-', ''))}`,
    ).toHaveLength(1);
    expect(described(made)).toContain(made.code);
    expect(described(made)).toContain(`in ${ENROLMENT_CODE.minutes} minutes`);
  });

  it('with --revoke-others, revokes every passkey and ends every session, recording each', async () => {
    const { browser } = await signedIn();
    await signedIn();
    const made = await enrol(db.enrol, { revokeOthers: true });
    expect(made.revoked).toEqual(['Laptop', 'Laptop']);
    expect(made.held).toEqual([]);
    expect((await browser.get('/admin/session')).status).toBe(401);
    expect(await db.owner`select 1 from sessions where ended_at is null`).toHaveLength(0);
    const revoked = await lastEvents(2);
    for (const event of revoked) {
      expect(event).toMatchObject({ type: 'passkey.revoked', actor: 'martin', payload: { from: 'command-line' } });
    }
    // The console shows them: the enrolment's role is Martin's.
    expect(await db.reader`select 1 from events where type = 'passkey.revoked'`).not.toHaveLength(0);
  });
});

describe('starting', () => {
  it('rejects when it cannot listen, and lets go of the store it was given', async () => {
    // The port the service started for this test holds.
    const { port } = service.server.address() as AddressInfo;
    const sql = as('factory_admin', PASSWORDS.admin);
    await expect(
      startAdmin(
        { origin: ORIGIN, rpId: RP_ID, trusted: proxies(''), port, profile: 'local' },
        { sql, port, host: '127.0.0.1', recheckMs: 100, held: false },
      ),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(sql`select 1`).rejects.toMatchObject({ code: 'CONNECTION_ENDED' });
  });
});
