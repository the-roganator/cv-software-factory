/**
 * Who may do what (spec section 5.4): every route the console's server and the admin service answer, and every action
 * Martin can take, each with the role it needs, whether it reads or writes, and, for a write, whether it needs his
 * passkey again. The servers refuse anything not in it; the console draws its controls from it, so a visitor sees every
 * control, read-only, with what it does.
 *
 * Human-owned: see `README.md`. `apps/console/test/access.test.ts` holds this table to the spec's list of what needs
 * the passkey again, and to the routes the servers answer.
 */
import type { HoldCause } from '../packages/events/src/vocabulary.ts';

/**
 * Who a request must be: anyone (a visitor), Martin signed in (admin), or someone holding an enrolment code, which is
 * the one write that takes no session: the code is its credential, used once.
 */
export const ROLES = ['visitor', 'admin', 'enrolment code'] as const;
export type Role = (typeof ROLES)[number];

/** A server's own: the console's read-only server, or the admin service, behind `/admin/` on the console's host. */
export type Server = 'console' | 'admin';

/**
 * A route, as `METHOD /path`: a `:name` segment matches one segment, and a last `*` matches the rest of the path. A
 * `GET` route answers `HEAD` too.
 */
export type Route = `${'GET' | 'POST'} /${string}`;

export interface Access {
  /** What it is, in the words the console shows beside its control. */
  what: string;
  role: Role;
  does: 'read' | 'write';
  /**
   * A write that loosens a control, raises spend, promotes something or overrides a guardrail needs the passkey again,
   * given within `STEP_UP.minutes`, so a stolen session does none of it. Always false for a read. An action that
   * loosens one way and tightens the other is two entries, one each way.
   */
  stepUp: boolean;
  /** Who answers its routes, if it has any yet: an action the admin service does not serve yet has none. */
  server?: Server;
  routes?: readonly Route[];
}

/** A session lasts this long from sign-in, however busy. There is no idle timeout: ADR 0012 says why. */
export const SESSION = { minutes: 60, idleTimeout: false } as const;

/** The passkey, given again, is fresh for this long. */
export const STEP_UP = { minutes: 5 } as const;

/**
 * `factory admin enrol`'s one-time code: its random bits, how long it lasts, and how many tries it allows, counted
 * across every client.
 */
export const ENROLMENT_CODE = { bits: 128, minutes: 10, tries: 5 } as const;

/** The most passkeys Martin holds at once: a laptop's and a phone's. */
export const PASSKEYS = { most: 2 } as const;

/**
 * The holds whose cause is a guardrail: approving one overrides it, so it needs the passkey again. Rejecting one,
 * answering it in words, or sending it back to the planner with his words, never does: each sends the change round the
 * line again, through every gate, and the planner may name no test the gates excuse that it could not name on any plan
 * of its own.
 */
export const GUARDRAIL_HOLDS = [
  'scope',
  'beyond-ticket',
  'review',
  'gates',
  'verify',
  'spend',
  'merge',
] as const satisfies readonly HoldCause[];

const read = (what: string) => ({ what, role: 'visitor', does: 'read', stepUp: false }) as const;
const admin = (what: string, stepUp = false) => ({ what, role: 'admin', does: 'write', stepUp }) as const;

export const ACCESS = {
  // The console's server: public reads, and nothing else.
  page: { ...read('The console'), server: 'console', routes: ['GET /', 'GET /index.html'] },
  files: { ...read("The console's scripts, styles, fonts and pictures"), server: 'console', routes: ['GET /assets/*'] },
  events: { ...read('Every public event after the one given'), server: 'console', routes: ['GET /api/events'] },
  stream: { ...read('The public events, live'), server: 'console', routes: ['GET /api/events/stream'] },
  artifacts: { ...read('An artifact a public event refers to'), server: 'console', routes: ['GET /artifacts/:hash'] },
  refusals: {
    ...read('Whether each relayed refusal is what the GitHub worker signed'),
    server: 'console',
    routes: ['GET /api/refusals'],
  },
  health: { ...read('Whether the console is up'), server: 'console', routes: ['GET /health'] },
  version: { ...read('The commit the console was built from'), server: 'console', routes: ['GET /version'] },

  // The admin service, behind `/admin/` on the console's host.
  'admin.health': { ...read('Whether the admin service is up'), server: 'admin', routes: ['GET /admin/health'] },
  'flags.held': {
    ...read(
      'Whether the app holds the flags as set: the revision, what its pods hold, since when, and when last asked',
    ),
    server: 'admin',
    routes: ['GET /admin/flags/held'],
  },

  // Views every visitor sees, drawn from the public events.
  'audit-log': read('Every agent action, model call and admin action, newest first'),
  settings: read("Each agent's model and effort, and spend against the caps"),
  flags: read("Each feature flag and its stage, and why a stage can't be taken now"),

  // Martin's own reads.
  'full-events': {
    what: 'The full events, live, with report text shown to Martin as text',
    role: 'admin',
    does: 'read',
    stepUp: false,
    server: 'admin',
    routes: ['GET /admin/events/stream'],
  },
  session: {
    what: 'This session: when it started and ends, when the passkey was last given, and the passkeys',
    role: 'admin',
    does: 'read',
    stepUp: false,
    server: 'admin',
    routes: ['GET /admin/session'],
  },
  'preview-as-visitor': {
    what: 'The public stream, as the server sends it to anyone without a session',
    role: 'admin',
    does: 'read',
    stepUp: false,
  },

  // Signing in and out. Signing in takes a passkey in place of a session; enrolling takes a code.
  'sign-in': {
    ...admin('Sign in with a passkey'),
    server: 'admin',
    routes: ['POST /admin/sign-in/options', 'POST /admin/sign-in'],
  },
  enrol: {
    what: 'Make a passkey on this device, with a one-time code from `factory admin enrol`',
    role: 'enrolment code',
    does: 'write',
    stepUp: false,
    server: 'admin',
    routes: ['POST /admin/enrol/options', 'POST /admin/enrol'],
  },
  'step-up': {
    ...admin('Give the passkey again, for the actions that ask for it in the next five minutes'),
    server: 'admin',
    routes: ['POST /admin/step-up/options', 'POST /admin/step-up'],
  },
  // Ending the passkey's five minutes early only tightens: the next action that needs it asks for it again.
  'step-up.end': {
    ...admin('End the passkey given again now, so the next action that asks for it asks again'),
    server: 'admin',
    routes: ['POST /admin/step-up/end'],
  },
  'sign-out': { ...admin('Sign out on this device'), server: 'admin', routes: ['POST /admin/sign-out'] },
  'sign-out-everywhere': {
    ...admin('Sign out on every device'),
    server: 'admin',
    routes: ['POST /admin/sign-out-everywhere'],
  },
  'passkey.revoke': {
    ...admin('Revoke a passkey', true),
    server: 'admin',
    routes: ['POST /admin/passkeys/:id/revoke'],
  },

  // Needs you: each answer names the hold the card showed. Approving is one route, and is one of the three below by the
  // stored hold's cause and the stored work item's kind, never the request's: the admin service asks for the passkey
  // again for a guardrail's, and for an improvement's spec, which sets the line building something new.
  'hold.approve': {
    ...admin(
      'Approve a hold: as `hold.approve-guardrail`, with the passkey again, when its cause is a guardrail; as ' +
        '`hold.approve-improvement-spec`, with the passkey again, when it holds an improvement’s spec; and with ' +
        'nothing more otherwise',
    ),
    server: 'admin',
    routes: ['POST /admin/holds/:workItem/approve'],
  },
  'hold.approve-guardrail': admin(`Approve a hold whose cause is a guardrail (${GUARDRAIL_HOLDS.join(', ')})`, true),
  'hold.approve-improvement-spec': admin(
    'Approve the spec of an improvement (a `spec` hold on a work item of kind improvement), so the line builds it',
    true,
  ),
  'hold.reject': { ...admin('Reject a hold'), server: 'admin', routes: ['POST /admin/holds/:workItem/reject'] },
  'hold.answer': {
    ...admin('Answer a hold in words: as `hold.share-words`, with the passkey again, when he shares them'),
    server: 'admin',
    routes: ['POST /admin/holds/:workItem/answer'],
  },
  'hold.replan': {
    ...admin(
      'Send a held work item back to the planner, with his words, where the spec may be what is wrong: as ' +
        '`hold.share-words`, with the passkey again, when he shares them',
    ),
    server: 'admin',
    routes: ['POST /admin/holds/:workItem/replan'],
  },
  // His words on a work item a visitor's report opened stay his, as no agent reads a report. Sharing them, as their
  // author, lets the agents read them and makes them public: it loosens what such a work item carries.
  'hold.share-words': admin(
    'Share his words on a hold of a work item a visitor’s report opened, so the agents read them and they are public',
    true,
  ),

  // The line. Stopping aborts the canary in flight too; `make stop-the-line` does the same without the console.
  'line.stop': { ...admin('Stop the line'), server: 'admin', routes: ['POST /admin/line/stop'] },
  'line.start': { ...admin('Start the line', true), server: 'admin', routes: ['POST /admin/line/start'] },
  'autonomy.tighten': admin('Make the autonomy level stricter'),
  'autonomy.loosen': admin('Make the autonomy level looser', true),
  'new-work.on': admin('Let agents take new work'),
  'new-work.off': admin('Stop agents taking new work'),
  'auto-merge.on': admin('Turn on auto-merge of low-risk changes', true),
  'auto-merge.off': admin('Turn off auto-merge of low-risk changes'),
  'auto-rollback.on': admin('Turn on auto-rollback: a canary the analysis judges bad rolls back by itself'),
  'auto-rollback.off': admin(
    'Turn off auto-rollback: a canary whose errors or latency the analysis judges bad pauses for you to promote or abort, overriding a guardrail',
    true,
  ),
  'take.widen': admin('Let the line take more work items, or any rather than one', true),
  'take.narrow': admin('Let the line take fewer work items, or just one'),
  // The line's controls, within policy (`line.ts`). A change is one route, and is the one of the actions above that it
  // does, by the controls in force as it is taken, never the request's word: the admin service asks for the passkey
  // again when that one needs it.
  'line.controls': {
    ...admin(
      "Change one of the line's controls: as `autonomy.loosen` or `autonomy.tighten`, `new-work.on` or `new-work.off`, " +
        '`auto-merge.on` or `auto-merge.off`, `take.widen` or `take.narrow`, `auto-rollback.on` or `auto-rollback.off`, ' +
        'by what it changes, with the passkey again ' +
        'when that one needs it',
    ),
    server: 'admin',
    routes: ['POST /admin/line/controls'],
  },

  // Alerts to Martin's phone (`phone.ts`): every alert at its level, or none. Off loosens what reaches him, as nothing
  // would; on tightens. A switch is one route, and is the one of the two it does, by its yes or no: the admin service
  // asks for the passkey again to switch them off.
  'phone.on': admin('Send every alert to your phone, at its level'),
  'phone.off': admin("Send no alert to your phone: Grafana's Alerts dashboard still shows them all", true),
  'phone.switch': {
    ...admin('Switch alerts to your phone: as `phone.on`, or as `phone.off`, with the passkey again'),
    server: 'admin',
    routes: ['POST /admin/alerts/phone'],
  },

  // A release in flight: the admin service changes the app's Rollout, the one service of ours that may.
  'release.promote': {
    ...admin("Promote a canary, to the next step's weight or fully", true),
    server: 'admin',
    routes: ['POST /admin/release/promote'],
  },
  'release.pause': { ...admin('Pause a canary'), server: 'admin', routes: ['POST /admin/release/pause'] },
  'release.resume': {
    ...admin('Give a paused canary back to its analysis'),
    server: 'admin',
    routes: ['POST /admin/release/resume'],
  },
  'release.abort': { ...admin('Abort a canary'), server: 'admin', routes: ['POST /admin/release/abort'] },
  'release.retry': {
    ...admin('Retry a release that was stopped', true),
    server: 'admin',
    routes: ['POST /admin/release/retry'],
  },

  // The feature flags' stages (`flag-moves.ts`), each written to `flags` (`flags.ts`). A move is one route, and is the
  // one of the actions below that it does, from the stage `flags` holds as it is taken, never the request's word: the
  // admin service asks for the passkey again when that one needs it. Off to Checks shows a change to nobody but the
  // factory's own checks, so it asks for nothing; narrowing and Off only tighten.
  'flag.to-checks': admin("Widen a flag from Off to Checks, which shows it to nobody but the factory's own checks"),
  'flag.widen': admin("Widen a flag's stage past Checks, a stage at a time but Preview, or to a larger share", true),
  'flag.back-on': admin('Turn a flag that was on for everyone, and turned off, straight back on for everyone', true),
  'flag.narrow': admin("Narrow a flag's stage, or its share, short of Off"),
  'flag.off': admin('Turn a flag off for everyone, with a reason'),
  'flag.stage': {
    ...admin(
      "Set a flag's stage: as `flag.to-checks`, `flag.widen`, `flag.back-on`, `flag.narrow` or `flag.off`, by the " +
        'move from the stage `flags` holds, with the passkey again when that one needs it',
    ),
    server: 'admin',
    routes: ['POST /admin/flags/:flag/stage'],
  },

  // The "+": an improvement widens what the line does, so asking for one needs the passkey again, as approving its spec
  // does. The work item's kind and title are the admin service's; only Martin's words come from the request.
  'improvement.request': {
    ...admin('Ask for an improvement, in your own words: the line plans it, and holds its spec for you', true),
    server: 'admin',
    routes: ['POST /admin/improvements'],
  },

  // A red-team attack (`attacks.ts`): one of spec 5.3's five, its content fixed in code, made by the red-team harness
  // against the real mechanism with no agent. It loosens nothing and asks the line for no work, so it asks for nothing
  // more. One at a time: a launch is refused while the last has neither finished nor passed its limit.
  'attack.launch': {
    ...admin('Launch a red-team attack against its real mechanism, one at a time: its refusal shows on its card'),
    server: 'admin',
    routes: ['POST /admin/attacks/:attack'],
  },

  // Models and spend, within policy (`settings.ts`). A save is one route, and is each of the four below that it does:
  // the admin service asks for the passkey again when any of them needs it, so a save that raises anything does.
  'agent.raise': admin('Give an agent a dearer model, or more effort', true),
  'agent.lower': admin('Give an agent a cheaper model, or less effort'),
  'caps.raise': admin('Raise a spend cap', true),
  'caps.lower': admin('Lower a spend cap'),
  'settings.save': {
    ...admin(
      "Save the agents' models and efforts and the spend caps: as `agent.raise` and `caps.raise` when it raises any, " +
        'with the passkey again, and as `agent.lower` and `caps.lower` when it only lowers',
    ),
    server: 'admin',
    routes: ['POST /admin/settings'],
  },
} as const satisfies Record<string, Access>;

export type Name = keyof typeof ACCESS;

/** The entries a server answers routes for. */
export type ServedBy<S extends Server> = {
  [K in Name]: (typeof ACCESS)[K] extends { server: S } ? K : never;
}[Name];

/** Whether a request's method and path are a route, and their values for its `:name` segments. */
export function matchRoute(route: Route, method: string, path: string): Record<string, string> | null {
  const [want = '', pattern = ''] = route.split(' ');
  if (method !== want && !(want === 'GET' && method === 'HEAD')) return null;
  const parts = pattern.split('/');
  const given = path.split('/');
  const values: Record<string, string> = {};
  for (const [i, part] of parts.entries()) {
    if (part === '*' && i === parts.length - 1) return given.length > i && given.slice(i).join('/') ? values : null;
    const value = given[i];
    if (value === undefined) return null;
    if (part.startsWith(':')) {
      if (!value) return null;
      values[part.slice(1)] = value;
    } else if (part !== value) return null;
  }
  return given.length === parts.length ? values : null;
}

/** The entry a server answers a request with, and its route's values, or null: the server refuses it. */
export function routeOf<S extends Server>(
  server: S,
  method: string,
  path: string,
): { name: ServedBy<S>; values: Record<string, string> } | null {
  for (const [name, access] of Object.entries(ACCESS) as [Name, Access][]) {
    if (access.server !== server) continue;
    for (const route of access.routes ?? []) {
      const values = matchRoute(route, method, path);
      if (values) return { name: name as ServedBy<S>, values };
    }
  }
  return null;
}
