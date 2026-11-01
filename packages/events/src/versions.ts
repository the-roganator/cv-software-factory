/**
 * Every event type, and the version of its payload that is current. One type for each thing a stage does.
 *
 * Real events are stored at these versions, so a payload never changes in place: a change raises its type's version
 * here and adds an upcaster (upcast.ts), so that stored events and recordings keep reading as the current version.
 */
export const VERSIONS = {
  // A work item, from first event to last
  'work-item.opened': 2,
  'work-item.summarised': 1,
  'work-item.closed': 2,
  'work-item.reopened': 3,
  // Before the line: what a visitor started
  'defect.injected': 1,
  'attack.launched': 1,
  // Sense and triage
  'signal.received': 4,
  'judgement.made': 1,
  'ticket.opened': 1,
  // Plan and build
  'spec.written': 4,
  'pull-request.pushed': 3,
  'suggestions.answered': 1,
  'wait.started': 1,
  // Gates and review
  'gates.started': 1,
  'gate.finished': 1,
  'gates.finished': 1,
  'review.submitted': 4,
  'review.accepted': 1,
  'pull-request.merged': 1,
  // Release and verify
  'deploy.changed': 1,
  'release.started': 3,
  'canary.stepped': 2,
  'canary.measuring': 1,
  'release.promoted': 2,
  'release.rolled-back': 4,
  'release.aborted': 1,
  'release.errored': 1,
  'verification.finished': 4,
  'signal.rechecked': 2,
  // Anywhere on the line
  'work.returned': 3,
  'hold.started': 10,
  'hold.answered': 2,
  'action.refused': 3,
  'model.called': 2,
  // The line as a whole, with no work item
  'line.started': 2,
  'line.stopped': 1,
  'spend.capped': 2,
  'spend.cleared': 2,
  'score.updated': 1,
  // A guardrail's proof, taken by `make guardrails` from the Mac
  'guardrail.proved': 1,
  // Martin signing in and out, and his passkeys (the admin service, and `factory admin enrol`)
  'admin.signed-in': 1,
  'admin.signed-out': 1,
  'admin.stepped-up': 1,
  'passkey.enrolled': 1,
  'passkey.revoked': 1,
  // Martin's controls of a release in flight (the admin service)
  'release.controlled': 2,
  // Martin's settings: each agent's model and effort, and the spend caps (the admin service)
  'settings.changed': 1,
  // Martin's controls of the line: the autonomy level, the switches, and what the line takes (the admin service)
  'controls.changed': 2,
  // Whether alerts reach Martin's phone (the admin service)
  'alerts.switched': 1,
  // Martin's stage of a feature flag (the admin service), Verify's comparison of its two sides at the share stage, and
  // its checks with the probes at Off, Checks and Preview
  'flag.staged': 1,
  'flag.compared': 2,
  'flag.checked': 3,
  // Martin's request for an improvement, in his own words (the admin service), with the work item it opens
  'improvement.requested': 1,
} as const;

export type EventType = keyof typeof VERSIONS;

export const EVENT_TYPES = Object.keys(VERSIONS) as EventType[];

/** Types that belong to the line as a whole. */
export const LINE_TYPES: readonly EventType[] = [
  'line.started',
  'line.stopped',
  'spend.capped',
  'spend.cleared',
  'score.updated',
  'guardrail.proved',
  'admin.signed-in',
  'admin.signed-out',
  'admin.stepped-up',
  'passkey.enrolled',
  'passkey.revoked',
  'release.controlled',
  'settings.changed',
  'controls.changed',
  'alerts.switched',
];

/**
 * Types that belong to a work item or to the line. A release's events are on each work item it carries, and on the
 * line when it carries none. Every other event belongs to a work item.
 */
export const RELEASE_TYPES: readonly EventType[] = [
  'release.started',
  'canary.stepped',
  'canary.measuring',
  'release.promoted',
  'release.rolled-back',
  'release.aborted',
  'release.errored',
];

/**
 * The line's record of what a release did: the types only the line's role may append (row security on `events`,
 * `0039_release-events-the-lines.sql`), save samples from Martin's command line. The rollback proof, the line's
 * security count and the console's Canary panel trust them for that: row security is what holds them to the line. A
 * release's start is not among them: the line records it, and nothing trusts it but beside these.
 */
export const LINE_ONLY_TYPES: readonly EventType[] = [
  'canary.stepped',
  'canary.measuring',
  'release.promoted',
  'release.rolled-back',
  'release.aborted',
  'release.errored',
];

/**
 * The proofs' own record: the type only the proofs' role (`factory_proofs`, which `make guardrails` connects as) may
 * append (row security on `events`, `0043_guardrail-proofs.sql`), save samples from Martin's command line. The line's
 * count of what pages Martin and the Guardrails panel trust a proof for that, and also read only those that role
 * appended.
 */
export const PROOFS_ONLY_TYPES: readonly EventType[] = ['guardrail.proved'];

/**
 * Martin's commands: the types only his roles may append (row security on `events`, `0023_martins-commands.sql`), and
 * that the line, triage and the gateway act on only when one of his roles appended it. Signing in and out, giving his
 * passkey again, and his passkeys are among them, so no worker can forge one (`0025_admin-service.sql`,
 * `0026_admin-stepped-up.sql`), and so are his controls of a release (`release.controlled`,
 * `0027_release-controls.sql`), his settings (`settings.changed`, `0028_settings.sql`), and his controls of the line
 * (`controls.changed`, `0030_line-controls.sql`), his switch of alerts to his phone (`alerts.switched`,
 * `0037_alerts-switched.sql`), his stages of a feature flag (`flag.staged`,
 * `0033_flag-stages.sql`), and his requests for an improvement (`improvement.requested`, `0035_improvement-requests.sql`,
 * which also lets only his roles open a work item of kind `improvement`, though `work-item.opened` is no command of his
 * alone). Each command the admin service adds joins this list when its type
 * joins the catalogue, and a migration adds it to the store's own list (`admin_event`): the store's tests fail until
 * the two agree. `release.aborted` is not one: it is the line's record of
 * what the Rollout did, and says `by: martin` when his control came first.
 */
export const ADMIN_TYPES: readonly EventType[] = [
  'hold.answered',
  'line.started',
  'line.stopped',
  'admin.signed-in',
  'admin.signed-out',
  'admin.stepped-up',
  'passkey.enrolled',
  'passkey.revoked',
  'release.controlled',
  'settings.changed',
  'controls.changed',
  'alerts.switched',
  'flag.staged',
  'improvement.requested',
];

export const isEventType = (type: string): type is EventType => Object.hasOwn(VERSIONS, type);
