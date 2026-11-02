/**
 * What the console keeps of the access table (`policy/access.ts`), which the admin service enforces: how long a
 * session lasts, how long the passkey given again is fresh, and which of Martin's controls ask for it, so the page draws the key where the service
 * will ask. The console's image is built without `policy/access.ts`, so it keeps these copies, and a test holds them to
 * the table.
 */
import type { HoldCause, ReleaseControl } from '@software-factory/events';
import type { FlagAction } from '@software-factory/policy/flag-moves';
import type { ControlAction } from '@software-factory/policy/line';

/** How long a session lasts from sign-in, however busy: `SESSION.minutes`. */
export const SESSION_MINUTES = 30;

/** How long the passkey, given again, is fresh: `STEP_UP.minutes`. */
export const FRESH_MINUTES = 5;

/**
 * Which of Martin's controls of the canary ask for the passkey again: `release.promote` (to the next step or fully) and
 * `release.retry`, since promoting and retrying ship to more people.
 */
export const STEP_UP: Record<ReleaseControl, boolean> = {
  promote: true,
  'promote-fully': true,
  pause: false,
  resume: false,
  abort: false,
  retry: true,
};

/**
 * Which of what a save of the settings does asks for the passkey again: a dearer model or more effort
 * (`agent.raise`), and a higher cap (`caps.raise`). A save that does any of them asks.
 */
export const SETTINGS_STEP_UP = {
  'agent.raise': true,
  'agent.lower': false,
  'caps.raise': true,
  'caps.lower': false,
} as const;

/**
 * The holds whose cause is a guardrail, `GUARDRAIL_HOLDS`: approving one overrides it, so it asks for the passkey again
 * (`hold.approve-guardrail`). Rejecting one, or answering it in words, never does.
 */
export const GUARDRAIL_HOLDS: readonly HoldCause[] = [
  'scope',
  'beyond-ticket',
  'review',
  'gates',
  'verify',
  'spend',
  'merge',
];

/** Starting the line asks for the passkey again (`line.start`); stopping it never does (`line.stop`). */
export const LINE_STEP_UP = { 'line.start': true, 'line.stop': false } as const;

/**
 * Which changes of the line's controls ask for the passkey again: a looser autonomy level (`autonomy.loosen`),
 * auto-merge turned on (`auto-merge.on`), a wider take (`take.widen`) and auto-rollback turned off
 * (`auto-rollback.off`). Which action a change is, is
 * `controlAction`'s in `policy/line.ts`, which the admin service decides by too.
 */
export const CONTROL_STEP_UP: Record<ControlAction, boolean> = {
  'autonomy.loosen': true,
  'autonomy.tighten': false,
  'new-work.on': false,
  'new-work.off': false,
  'auto-merge.on': true,
  'auto-merge.off': false,
  'take.widen': true,
  'take.narrow': false,
  'auto-rollback.off': true,
  'auto-rollback.on': false,
};

/** Switching alerts to the phone off asks for the passkey again (`phone.off`); switching them on never does. */
export const PHONE_STEP_UP = { 'phone.on': false, 'phone.off': true } as const;

/**
 * Which moves of a feature flag's stage ask for the passkey again: every widening past Checks (`flag.widen`) and
 * turning a flag back on for everyone (`flag.back-on`); Off to Checks, narrowing and Off never do. Which action a move
 * is, is `flagAction`'s in `policy/flag-moves.ts`, which the admin service decides by too.
 */
export const FLAG_STEP_UP: Record<FlagAction, boolean> = {
  'flag.to-checks': false,
  'flag.widen': true,
  'flag.back-on': true,
  'flag.narrow': false,
  'flag.off': false,
};

/**
 * Asking for an improvement (`improvement.request`) and approving an improvement's spec
 * (`hold.approve-improvement-spec`) both ask for the passkey again: each sets the line building something new.
 */
export const IMPROVEMENT_STEP_UP = {
  'improvement.request': true,
  'hold.approve-improvement-spec': true,
} as const;
