/**
 * The access table (`policy/access.ts`) against what it answers to: the spec's list of what needs the passkey again,
 * the design's list of guardrail holds, and the routes the console's server answers. The admin service's routes are
 * held to it by `apps/factory/test/admin/admin.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { HOLD_CAUSES } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import {
  ACCESS,
  type Access,
  GUARDRAIL_HOLDS,
  matchRoute,
  type Name,
  ROLES,
  routeOf,
  SESSION,
  STEP_UP,
} from '../../../policy/access.ts';
import {
  CONTROL_STEP_UP,
  FLAG_STEP_UP,
  IMPROVEMENT_STEP_UP,
  LINE_STEP_UP,
  PHONE_STEP_UP,
  SESSION_MINUTES,
} from '../web/src/access.ts';

const entries = Object.entries(ACCESS) as [Name, Access][];
const doc = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf-8');

/**
 * Each thing spec section 5.4 says needs the passkey again, and the entries that are it. Widening a flag's stage is
 * every widening but Off to Checks (`flag.to-checks`), which shows a change to nobody but the factory's own checks, as
 * the plan's list says, and turning a flag back on for everyone.
 */
const SPEC_STEP_UP: Record<string, Name[]> = {
  'raising a cap or a setting that raises spend': ['caps.raise', 'agent.raise', 'take.widen'],
  'loosening autonomy': ['autonomy.loosen'],
  'turning auto-merge on or auto-rollback off': ['auto-merge.on', 'auto-rollback.off'],
  'switching alerts to his phone off': ['phone.off'],
  'starting the line': ['line.start'],
  'promoting a canary or retrying a stopped release': ['release.promote', 'release.retry'],
  "widening a flag's stage": ['flag.widen', 'flag.back-on'],
  'requesting an improvement or approving its spec': ['improvement.request', 'hold.approve-improvement-spec'],
  'approving a hold whose cause is a guardrail': ['hold.approve-guardrail'],
  'revoking a passkey': ['passkey.revoke'],
};

describe('the access table', () => {
  it('marks exactly what the spec says needs the passkey again', () => {
    const spec = doc('docs/SPECIFICATION.md');
    const [, listed = '', last = ''] =
      /overrides a guardrail \(([^)]+)\) and ([a-z ]+) need the passkey again/.exec(spec) ?? [];
    expect([...listed.split(', '), last].sort()).toEqual(Object.keys(SPEC_STEP_UP).sort());
    const marked = entries.filter(([, access]) => access.stepUp).map(([name]) => name);
    expect(marked.sort()).toEqual(Object.values(SPEC_STEP_UP).flat().sort());
  });

  it('names the guardrails’ holds the design marks with the key, each a cause the line knows', () => {
    const design = doc('docs/design/system/README.md');
    const [, listed = ''] = /Approve carries the key when the cause is a guardrail \(([^)]+)\)/.exec(design) ?? [];
    expect(listed.split(', ').map((cause) => cause.replaceAll('`', ''))).toEqual([...GUARDRAIL_HOLDS]);
    for (const cause of GUARDRAIL_HOLDS) expect(HOLD_CAUSES).toContain(cause);
  });

  it('asks for the passkey on writes only, and gives a visitor none this milestone', () => {
    for (const [name, access] of entries) {
      expect(ROLES, name).toContain(access.role);
      if (access.does === 'read') expect(access.stepUp, name).toBe(false);
      if (access.role === 'visitor') expect(access.does, name).toBe('read');
    }
    expect(entries.filter(([, a]) => a.role === 'enrolment code').map(([name]) => name)).toEqual(['enrol']);
  });

  it('is copied into the console where it marks the line’s controls with the key', () => {
    const copies = { ...LINE_STEP_UP, ...CONTROL_STEP_UP, ...PHONE_STEP_UP, ...FLAG_STEP_UP, ...IMPROVEMENT_STEP_UP };
    for (const [name, asks] of Object.entries(copies)) {
      expect(ACCESS[name as Name]?.stepUp, name).toBe(asks);
    }
    // Every action of the line's controls the table names.
    const named = Object.keys(ACCESS).filter((name) =>
      /^(autonomy|new-work|auto-merge|auto-rollback|take)\./.test(name),
    );
    expect(Object.keys(CONTROL_STEP_UP).sort()).toEqual(named.sort());
    // Every move of a flag's stage the table names, but the one route that is each of them.
    const moves = Object.keys(ACCESS).filter((name) => name.startsWith('flag.') && name !== 'flag.stage');
    expect(Object.keys(FLAG_STEP_UP).sort()).toEqual(moves.sort());
    // Both ways of the switch of alerts to the phone, but the one route that is each of them.
    const switches = Object.keys(ACCESS).filter((name) => name.startsWith('phone.') && name !== 'phone.switch');
    expect(Object.keys(PHONE_STEP_UP).sort()).toEqual(switches.sort());
  });

  it('holds the plan’s figures: an hour a session with no idle timeout, five minutes a passkey given again', () => {
    expect(SESSION).toEqual({ minutes: 60, idleTimeout: false });
    // The console's copy, which its image is built with in place of the table.
    expect(SESSION_MINUTES).toBe(SESSION.minutes);
    expect(STEP_UP).toEqual({ minutes: 5 });
  });

  it('gives the console’s server public reads alone, and no route twice', () => {
    const routes = entries.flatMap(([, access]) => access.routes ?? []);
    expect(new Set(routes).size).toBe(routes.length);
    for (const [name, access] of entries) {
      if (access.routes) expect(access.server, name).toBeDefined();
      if (access.server !== 'console') continue;
      expect(access.role, name).toBe('visitor');
      expect(access.does, name).toBe('read');
      for (const route of access.routes ?? []) expect(route.startsWith('GET '), route).toBe(true);
    }
  });
});

describe('a route', () => {
  it('matches its method, its segments and its rest, and nothing more', () => {
    expect(matchRoute('GET /', 'GET', '/')).toEqual({});
    expect(matchRoute('GET /', 'HEAD', '/')).toEqual({});
    expect(matchRoute('GET /', 'POST', '/')).toBeNull();
    expect(matchRoute('GET /', 'GET', '/x')).toBeNull();
    expect(matchRoute('GET /artifacts/:hash', 'GET', '/artifacts/abc')).toEqual({ hash: 'abc' });
    expect(matchRoute('GET /artifacts/:hash', 'GET', '/artifacts/')).toBeNull();
    expect(matchRoute('GET /artifacts/:hash', 'GET', '/artifacts/a/b')).toBeNull();
    expect(matchRoute('GET /assets/*', 'GET', '/assets/a/b.js')).toEqual({});
    expect(matchRoute('GET /assets/*', 'GET', '/assets/')).toBeNull();
    expect(matchRoute('GET /assets/*', 'GET', '/assets')).toBeNull();
    expect(matchRoute('POST /admin/sign-in', 'GET', '/admin/sign-in')).toBeNull();
  });

  it('is answered by the console’s server only if the table gives it the console', () => {
    expect(routeOf('console', 'GET', '/api/events')?.name).toBe('events');
    expect(routeOf('console', 'GET', '/artifacts/abc')).toEqual({ name: 'artifacts', values: { hash: 'abc' } });
    expect(routeOf('console', 'GET', '/admin/')).toBeNull();
    expect(routeOf('console', 'POST', '/api/events')).toBeNull();
    expect(routeOf('console', 'GET', '/.env')).toBeNull();
  });
});
