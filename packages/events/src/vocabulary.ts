/**
 * The closed lists the events are written in. Plain values, so the browser can import them without Zod.
 */

/** The line, in order (TERMS.md). */
export const STAGES = ['sense', 'triage', 'plan', 'build', 'gates', 'review', 'release', 'verify'] as const;
export type Stage = (typeof STAGES)[number];

/** What a work item is (spec 5.2). */
export const KINDS = [
  'defect-fix',
  'injected-defect',
  'improvement',
  'dependency-update',
  'red-team',
  'visitor-report',
  /** Something the planner noticed outside its ticket, which triage judges as it judges a visitor's report. */
  'planner-finding',
] as const;
export type Kind = (typeof KINDS)[number];

/** The defect categories of spec section 3.1. */
export const DEFECT_CATEGORIES = [
  'content',
  'navigation',
  'functional',
  'errors',
  'performance',
  'accessibility',
  'security',
  'observability',
] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

/** A card's category: a defect's, or the kind of work when there is no defect. */
export const CATEGORIES = [...DEFECT_CATEGORIES, 'improvement', 'dependency', 'red-team', 'not-a-defect'] as const;
export type Category = (typeof CATEGORIES)[number];

/** How a defect shows itself from outside. Tickets and the answer key share these, so matching needs no judgement. */
export const SYMPTOM_CLASSES = [
  'broken-link',
  'broken-image',
  'redirect-loop',
  'wrong-result',
  'rejects-valid-input',
  'server-error',
  'browser-error',
  'slow-response',
  'not-cached',
  'missing-alt',
  'low-contrast',
  'unlabelled-field',
  'missing-header',
  'leaks-detail',
  'missing-log',
  'wrong-metric',
] as const;
export type SymptomClass = (typeof SYMPTOM_CLASSES)[number];

/**
 * What the senses read besides the app, which triage looks at before it trusts a sense's new problem: Prometheus, Loki
 * and Tempo, and the disk under the cluster's volumes.
 */
export const DEPENDENCIES = ['prometheus', 'loki', 'tempo', 'disk'] as const;
export type Dependency = (typeof DEPENDENCIES)[number];

/** A ticket's severity: how badly the problem hurts a visitor. */
export const SEVERITIES = ['cosmetic', 'degraded', 'broken'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What triage's category question may answer for a report: a defect's category, or one of the two that are not. */
export const REPORT_CATEGORIES = [...DEFECT_CATEGORIES, 'suggestion', 'not-a-defect'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Where triage sends what it takes from the inbox: a new ticket, an open ticket it repeats, Martin (a suggestion),
 * quarantine (instructions aimed at the system), or nowhere (not a defect).
 */
export const TRIAGE_ROUTES = ['ticket', 'repeat', 'park', 'quarantine', 'discard'] as const;
export type TriageRoute = (typeof TRIAGE_ROUTES)[number];

/**
 * The factory's senses. Five watch the stable version; the canary is the release's analysis, which sees a new version
 * do worse than the one it would replace, and says so when it rolls it back.
 */
export const SENSES = ['probe', 'crawler', 'metrics', 'logs', 'canary', 'report'] as const;
export type Sense = (typeof SENSES)[number];

/**
 * Where a signal comes from: one of the senses, or the planner, which leaves triage what it noticed outside its
 * ticket. A planner's finding is its own words about public code, so triage trusts it no more than a visitor's report.
 */
export const SIGNAL_SOURCES = [...SENSES, 'planner'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** Whether a signal came from one of the senses, not the planner. */
export const isSense = (source: SignalSource): source is Sense => source !== 'planner';

/** The agents, each with its own budget and model settings. Triage is a Jev question set and routing code. */
export const AGENTS = ['triage', 'planner', 'coder', 'reviewer', 'describer', 'red-team'] as const;
export type Agent = (typeof AGENTS)[number];

/** Who did it. People, agents, and the systems around them. A visitor is never named: their key is a credential. */
export const ACTORS = [
  'martin',
  'visitor',
  ...AGENTS,
  ...SENSES.filter((sense) => sense !== 'report'),
  'widget',
  'injector',
  'actions',
  'rollouts',
  'dependabot',
  'factory',
  'scoreboard',
] as const;
export type Actor = (typeof ACTORS)[number];

/**
 * What may refuse an action (`action.refused`): GitHub refusing the App's token, its ruleset, the runners' egress
 * policy, admission control in a guarded namespace, the coder's scope fence, the GitHub worker's own guard, the review
 * check, the gateway, and triage's typed judgement quarantining a report. `policy/refusals.ts` says which roles may
 * append each, and which of spec 6's guardrails each shows.
 */
export const REFUSAL_MECHANISMS = [
  'token-permission',
  'ruleset',
  'egress-policy',
  'admission-control',
  'scope-fence',
  'github-guard',
  'review-gate',
  'gateway',
  'typed-judgement',
] as const;
export type RefusalMechanism = (typeof REFUSAL_MECHANISMS)[number];

/** Spec 6's guardrails, by number: a refusal names the ones it shows. */
export const GUARDRAIL_COUNT = 11;

/** Who answers a model call: Anthropic's API, Amazon Bedrock, or a model running on Martin's Mac (LM Studio). */
export const MODEL_PROVIDERS = ['anthropic', 'bedrock', 'local'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The agents that call a model through the gateway, from a runner: each has a model and effort Martin chooses. */
export const MODEL_AGENTS = ['planner', 'coder', 'reviewer', 'describer'] as const satisfies readonly Agent[];
export type ModelAgent = (typeof MODEL_AGENTS)[number];

/** Claude's efforts, least first. A local model takes none. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The spend caps Martin sets, as a settings change names them. */
export const SPEND_CAPS = ['day', 'month', 'work-item'] as const;
export type SpendCap = (typeof SPEND_CAPS)[number];

/** Why a provider refused to answer, when it is a cap the factory does not own. */
export const PROVIDER_CAPS = ['credit', 'workspace-limit', 'unreachable'] as const;
export type ProviderCap = (typeof PROVIDER_CAPS)[number];

/**
 * Why a work item is held for Martin, so the line knows what his answer means (the line's `machine.ts` has a rule for
 * each). `unknown` is a hold that recorded no cause.
 */
export const HOLD_CAUSES = [
  /** Triage parked a suggestion, a visitor's or the planner's: only Martin asks for improvements. */
  'suggestion',
  /**
   * Triage parked a defect the planner noticed outside its ticket: the planner's word alone never opens a ticket, so
   * it waits for a sense to see it or for Martin.
   */
  'finding',
  /**
   * Triage held a burst: one sense found more new problems at once than a handful, so their tickets wait, unopened,
   * for Martin to look at what it saw before any reaches Plan.
   */
  'burst',
  /**
   * Triage held a sense's new problem because something the sense reads besides the app was not seen to be healthy
   * when it saw it: the problem may be the factory's environment, which no agent can mend, so it waits for Martin.
   */
  'environment',
  /** A spec waits for Martin's approval before anything is built: an improvement's, or one tagged `out-of-scope`. */
  'spec',
  /** An agent asks Martin something only he can say. */
  'question',
  /** The planner judged the ticket one it cannot turn into a testable fix. */
  'ticket-rejected',
  /** The coder changed files outside the spec's scope. */
  'scope',
  /** The coder's first round found nothing to change: it says the code already does what the spec asks. */
  'nothing-to-fix',
  /** A step failed as often as the line allows. */
  'failures',
  /** The gates kept failing after the returns to the coder the line allows. */
  'gates',
  /** The reviewer escalated, or still asked for changes after the last review the line allows. */
  'review',
  /**
   * The reviewer found the spec or the change going beyond what the ticket asks: the coder cannot put a spec right, so
   * Martin's answer sends it back to the planner.
   */
  'beyond-ticket',
  /** The change passed its gates and review, and waits for Martin to merge it. */
  'merge',
  /**
   * The change is merged and waits at Release for a deploy pull request to carry it, which Martin merges. A release
   * that carries it ends the hold by itself; one that rolls back, that Martin aborts, or whose analysis errs, holds it
   * again, for the next or for his retry.
   */
  'deploy',
  /**
   * With auto-rollback off, the canary's analysis judged it worse than its baseline and, rather than roll it back,
   * Argo Rollouts paused it for Martin: it keeps its share of the traffic until he promotes it fully or aborts it, from
   * the Canary panel's own controls. It takes no answer of the holds': a promotion, an abort or a rollback ends it.
   */
  'canary',
  /** Verification after the release could not settle the ticket by itself, and waits for Martin to say. */
  'verify',
  /** The work item has spent as much on models as one may: the gateway refuses its agents' calls. */
  'spend',
  /** The change's new tests pass without the fix (the tests-first check), so they prove nothing about it. */
  'tests-first',
  'unknown',
] as const;
export type HoldCause = (typeof HOLD_CAUSES)[number];

/**
 * Where the deploy pull request that carries a work item held for a deploy stands, as the line reads it from GitHub:
 * open with the required checks on its head running, all passed, or one failed; merged; or closed unmerged. Only once
 * its checks have passed does it wait for Martin.
 */
export const DEPLOY_STATES = ['checking', 'passed', 'failed', 'merged', 'closed'] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];

/** Martin's answers to a hold: approve it, reject it, or answer it in words. */
export const HOLD_ANSWERS = ['approved', 'rejected', 'answered'] as const;
export type HoldAnswer = (typeof HOLD_ANSWERS)[number];

export const AUTONOMY = ['supervised', 'guarded', 'lights-out'] as const;
export type Autonomy = (typeof AUTONOMY)[number];

/**
 * Martin's controls of the line, from the console's Controls (the admin service): the autonomy level, whether agents
 * take new work, whether low-risk changes merge by themselves, what the line takes, and whether a canary the analysis
 * judges bad rolls back by itself or pauses for him.
 */
export const LINE_CONTROLS = ['autonomy', 'new-work', 'auto-merge', 'take', 'auto-rollback'] as const;
export type LineControl = (typeof LINE_CONTROLS)[number];

/** What the line takes: every ticket, the next few from when Martin set it, or just one work item. */
export const TAKES = ['every', 'next-few', 'just-one'] as const;
export type TakeKind = (typeof TAKES)[number];

/**
 * A feature flag's stages, in the order it widens through them, and the shares of the traffic generator's requests the
 * share stage may take, in percent. The same as `policy/flags.ts`'s, which renders them for flagd: a test holds the two
 * to each other.
 */
export const FLAG_STAGES = ['off', 'checks', 'preview', 'share', 'everyone'] as const;
export type FlagStage = (typeof FLAG_STAGES)[number];
export const FLAG_SHARES = [10, 25, 50] as const;
export type FlagShare = (typeof FLAG_SHARES)[number];

/**
 * What a move of a flag's stage is, as the access table names it (`policy/access.ts`): Off to Checks, any other
 * widening, turning a flag back on for everyone, narrowing, and Off.
 */
export const FLAG_ACTIONS = ['flag.to-checks', 'flag.widen', 'flag.back-on', 'flag.narrow', 'flag.off'] as const;
export type FlagActionName = (typeof FLAG_ACTIONS)[number];

/** How Verify's comparison of a flag's two sides at the share stage came out. */
export const FLAG_COMPARISONS = ['passed', 'failed'] as const;
export type FlagComparison = (typeof FLAG_COMPARISONS)[number];

/** The stages at which Verify checks a flag with the probes: Off, its baseline, and then Checks and Preview. */
export const FLAG_CHECK_STAGES = ['off', 'checks', 'preview'] as const;
export type FlagCheckStage = (typeof FLAG_CHECK_STAGES)[number];

/**
 * The colour schemes Verify pictures a flag's pages in, as the browser says it prefers (`prefers-color-scheme`): each
 * page in both, so a change that answers to either shows.
 */
export const COLOR_SCHEMES = ['light', 'dark'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/**
 * Whether a check of a flag pictured each page it pictured in both colour schemes: a page pictured in one alone, or
 * with no scheme named (taken before Verify named one, in the browser's default, light), is not. One that pictured no
 * page at all has none missing. A baseline counts for Checks only when it has (`policy/flag-moves.ts`), and the line
 * takes one that has not again.
 */
export function inBothSchemes(pages: readonly { page: string; scheme?: string }[]): boolean {
  const schemes = new Map<string, Set<string>>();
  for (const { page, scheme = 'light' } of pages) schemes.set(page, (schemes.get(page) ?? new Set()).add(scheme));
  return [...schemes.values()].every((taken) => taken.has('light') && taken.has('dark'));
}

/** How Verify's check of a flag at Checks or Preview came out: unsure when it had nothing to compare with. */
export const FLAG_CHECKS = ['passed', 'failed', 'unsure'] as const;
export type FlagCheck = (typeof FLAG_CHECKS)[number];

/** Tags that route a change to a human, depending on autonomy (docs/COMPONENTS/APPROVAL-ROUTING.md). */
export const RISKS = ['test-loosening', 'dependency-change', 'security-headers', 'out-of-scope'] as const;
export type Risk = (typeof RISKS)[number];

/**
 * Tags that hold a spec for Martin in every autonomy mode: a guardrail, not something the autonomy level decides. A
 * fix that changes behaviour beyond what its ticket is about needs a person, whatever the line is trusted with.
 */
export const ALWAYS_HELD: readonly Risk[] = ['out-of-scope'];

/**
 * Martin's controls of a canary in flight, from the console's Canary panel (the admin service): promote it to the next
 * step's weight, or fully; pause it, and give it back to its analysis; abort it; and retry a release that was stopped.
 * A rollback stays the analysis's alone, so there is no such control.
 */
export const RELEASE_CONTROLS = ['promote', 'promote-fully', 'pause', 'resume', 'abort', 'retry'] as const;
export type ReleaseControl = (typeof RELEASE_CONTROLS)[number];

/** The only types an artifact may have. The console serves each with the type it was stored with, never a guess. */
export const ARTIFACT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/json'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** The most steps of a canary a release's start records. */
export const MAX_CANARY_STEPS = 20;

/** The most findings one review carries, so each reaches the events whole. */
export const MAX_FINDINGS = 20;

/** The most files outside its scope a coder may say it needs, so each reaches its hold whole. */
export const MAX_NEEDS = 20;

/** The most a coder may say of why it needs one of them. */
export const NEED_REASON_CHARS = 200;

/**
 * The most Martin's own reason may be, as he writes it in the console's dialogs and `make stop-the-line`: why he stopped
 * or started the line (`line.stopped`, `line.started`), or moved a flag (`flag.staged`). The admin service takes its
 * limit from those events, and the console counts against it.
 */
export const MARTIN_REASON_CHARS = 200;
