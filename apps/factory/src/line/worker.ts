/**
 * The line after triage: takes tickets, and the improvements Martin asks for, into Plan and carries each work item
 * through its agents' steps, the gates and review, to Martin's merge, and on to Release and Verify. What to do next is
 * decided from the work item's events (`machine.ts`); this module does it, and appends what happened. A merged work
 * item is held at Release until a release carries it, and waits there while the release runs; a promoted one waits at
 * Verify.
 *
 * - A step runs in a runner (`Steps`), and its handback becomes events: the agent's result read through its schema,
 *   what the result does in GitHub (both in the agent's module, `agents/`), and one `model.called` with the step's
 *   calls. A step that hands back nothing, ends unfinished, or hands back a result its schema refuses, has failed;
 *   the step runs again, as a new job, up to a limit.
 * - Only that counts against a step. When GitHub or the store fails while a handback's effects are done, the handback
 *   is kept (`Queue.keep`) and its effects are tried again later, without running the agent again; each write is
 *   recorded as it is begun and done, so none is done twice. After `LIMITS.effects` tries the work item holds.
 * - At most one step at a time in each of Plan, Build and Review, and a ticket comes onto the line only when nothing
 *   is in Plan or waiting for Build (`queue.ts`). Each work item is leased while it is acted on.
 * - At most one step at a time on the local model, whatever its stage: LM Studio answers one prediction at a time, so
 *   two steps on it would each take about twice as long. A step whose agent `policy/models.ts` sends there waits
 *   while another such step runs, and the next pass tries again. Steps on Claude never wait on it.
 * - It reads its pull requests' gates and merges through the GitHub worker about once a minute (`gates.ts`).
 * - About as often, it tells the app's deploy pull request which work items it carries: those whose fixes merged
 *   between the commit the app runs and the one the pull request runs, as a release starting records them. It says
 *   so only when the list, or the pull request, has changed since it last did. Not with `only`: a soak of one work
 *   item says nothing of the others. And it records, on each work item held for a deploy that the pull request
 *   carries, where that pull request stands: its checks running, passed or failed, merged, or closed (`deploy.ts`),
 *   with `only` too, for that work item.
 * - An improvement, once a release that carries it is promoted, is handed over: one comment on its issue says it is in
 *   the app behind its flag, off, and that Martin widens it from the console, and its row on the line ends. No sense
 *   looks at it: it has no signal. The work item stays open, for the flag pass below.
 * - About every thirty seconds, while the line runs, it judges each improvement's work item at the stage Martin set its
 *   flag at, from the flags' events, not the ticket machine (`flags.ts`): a flag turned off closes its improvement as
 *   turned off, and its issue as not planned, and a flag at Share has its two sides compared on the traffic
 *   generator's requests, through Verify's Prometheus (`compare.ts`). Live and in a dry run, and with `only`, for that
 *   work item alone.
 * - About every thirty seconds, it reads the app's Rollout and its AnalysisRuns, and records each release on the work
 *   items it carries, or on the line when it carries none (`release.ts`). It changes nothing in Kubernetes. In a dry
 *   run, it answers for the releases of the dry run's merges, which never shipped.
 * - Once a release is promoted, it asks the sense that saw each work item's defect to look again (`verify.ts`), one
 *   look at a time for each work item, beside the steps. A look that cannot tell yet is tried again a few minutes
 *   later. A cleared signal closes the work item as verified, and its issue as completed with what cleared it; one
 *   that persists sends the work back to Plan, and the coder starts afresh, not from its old session.
 * - After each real release is promoted, and once as a hold or a wait starts, it asks the sense that saw each held or
 *   waiting work item's defect to look again at the version the stable Service runs (`lookDue`), one such look at a
 *   time across the line, beside Verify's, and takes no pictures: there is no fix to compare. A look that cannot tell
 *   is tried again a few minutes later, until the policy's wait. A cleared signal on a hold the line made itself, or on
 *   a waiting work item, closes it as verified: its issue as completed, and its pull request, if it has one open,
 *   unmerged, each saying what cleared it and on which release. A hold that waits on Martin's judgement records the
 *   look and stays; his closing its pull request while the clearance stands closes it as verified.
 * - As it takes a ticket whose signal was last seen on a version before the one the stable Service runs, before its
 *   issue opens and the planner starts, the sense looks again the same way (`atTake`); and as Verify clears a fix, at
 *   each open ticket it has not taken of the same sense and symptom (`#besideFix`; not with `only`). A cleared signal
 *   closes the ticket as verified, with no issue opened and nothing spent, naming the fixes the releases since its
 *   signal carried (`#carriedSince`), which every look again credits.
 * - After Plan, a work item whose spec's scope shares a file with the spec of another in flight waits, at its own
 *   stage, until each it waits on is verified or closed; then its sense looks again, and it closes as verified or goes
 *   on to Build. It holds up no other ticket. Not with `only`: a queue of one sees nothing else.
 * - A verified work item whose ticket triage reopened, because its signal came back, comes back into Plan for a fresh
 *   pass once its issue is open again, with a comment saying what came back.
 * - As it starts live, it ends what a dry run left on real tickets (`dryRunLeft`), which it could not carry on from:
 *   a work item whose pull request was the dry run's, merged or not, closes with no change, so the next signal of its
 *   defect opens a fresh ticket; a ticket the dry run verified, whose fix never shipped, reopens, and comes back into
 *   Plan as any reopened ticket does.
 * - What it takes is Martin's take from the console's Controls (`policy/line.ts`), read each pass, or, with none in
 *   force, its own default (`only`, `take`: LINE_ONLY and LINE_TAKE): every ticket, the next few from when he chose
 *   them, or just one (`queue.ts`).
 * - With just one (`only`), it acts on that one work item, taking its ticket onto the line if it is not there: it
 *   starts no step for any other, reads nothing for it and appends nothing, so a soak can take one ticket end to end.
 *   It still watches the app's releases, and records one that carries that work item or none.
 * - With Martin's switch for new work off, it takes no new ticket and starts no agent's step; a step in hand finishes,
 *   and the rest goes on: Release, Verify, the looks again, and a kept handback's effects. Unlike stopping the line,
 *   it aborts nothing, and starting new work again needs no passkey.
 * - When the line stops, it stops every step in hand, wherever it is, and takes nothing new; their work is lost and
 *   nothing of it is recorded, so starting again runs those steps afresh from the last event. It still watches the
 *   app's releases, which only reads and records, so the abort Stop the line makes is recorded as it happens; a dry
 *   run's releases wait for the line to start again.
 * - A work item's runners' volume is deleted when it merges, as nothing after a merge needs it (a return to Plan
 *   starts afresh from main), so the work items waiting at Release and Verify hold none of the runners' quota; and
 *   when it ends, closed, if it has one still.
 *
 * In a dry run, a pull request's head is a commit GitHub never had: the GitHub worker says which real commit it went
 * on and what the dry run's commits were, and the runner makes them before the step starts.
 *
 * It acts in GitHub only through the GitHub worker, and every agent's model through the gateway: it holds no key.
 */
import { hostname } from 'node:os';
import { trace } from '@opentelemetry/api';
import type {
  Effort,
  Evidence,
  NewEvent,
  PayloadOf,
  RawEvent,
  SignalSource,
  SymptomClass,
} from '@software-factory/events';
import {
  cutAt,
  cutTo,
  returnWords,
  SENSES,
  scopesOverlap,
  upcast,
  WORDS_LEAVE_HELD,
  workItemsWords,
} from '@software-factory/events';
import {
  askedByMartin,
  byMartin,
  type EventWriter,
  flagsTaken,
  fromMartin,
  IgnoredCommands,
  LINE_ROLE,
  lastEnd,
  latestControls,
  lineStopped,
  sendSignal,
} from '@software-factory/store';
import { uuidFrom } from '@software-factory/triage/events';
import type { Logger } from 'pino';
import type { JSONValue, Sql } from 'postgres';
import { type Controls, controlsInForce } from '../../../../policy/line.ts';
import { release as RELEASE } from '../../../../policy/release.ts';
import { sendCounts } from '../counts.ts';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import { type Carry, DEPLOYS, type DeployProposal, MAX_CARRIES } from '../github/deploys.ts';
import type {
  ActingFor,
  ActionArgs,
  ActionName,
  ActionResult,
  ReadArgs,
  ReadName,
  ReadResult,
} from '../github/server.ts';
import { issueGone } from '../github/worker-client.ts';
import type { PictureIndex } from '../pictures/index.ts';
import type { StepOutcome, StepRequest } from '../runners/steps.ts';
import { ATTRIBUTES as A, inSpan } from '../spans.ts';
import {
  type Bounds,
  boundsOn,
  count,
  type EffectsContext,
  holdDraft,
  LOCAL_MODEL_PACE,
  need,
  type StepContext,
  StepFailed,
  StepStale,
  stepFrom,
} from './agents/agent.ts';
import type { Request, Signal } from './agents/evidence.ts';
import { AGENTS, type Agents } from './agents/index.ts';
import { capOn, capsInForce, lastSeq } from './caps.ts';
import { type HeldForDeploy, latestDeploy, recordDeploys } from './deploy.ts';
import { FlagPass } from './flags.ts';
import { asEvent, type Draft, gateEvents, gateRecord } from './gates.ts';
import { closeIssue } from './issues.ts';
import {
  acceptedFindings,
  atTake,
  closesWhenCleared,
  decide,
  dryRunLeft,
  type Facts,
  fold,
  LIMITS,
  type LineAgent,
  type LineEvent,
  lookDue,
  type Next,
  STAGE_OF,
  type WorkItemState,
} from './machine.ts';
import {
  type Carrying,
  countRecorded,
  countStep,
  limitsFor,
  observeHolds,
  observeStages,
  observeTaken,
  type StepEnding,
  zeroCounts,
} from './metrics.ts';
import { stepCalls, workItemSpend } from './model-calls.ts';
import { type Own, pagesFor } from './pictures.ts';
import { type Pending, Queue, type QueueItem, type Takes, takesOf } from './queue.ts';
import { type Carried, carried, Releases, type ReleaseWatchOptions } from './release.ts';
import { acceptedThreads, resolveThreads } from './review.ts';
import {
  closingComment,
  closingPullComment,
  type FirstSignal,
  type FlagChecksPort,
  type Look,
  look,
  reopeningComment,
  type Target,
  type VerifyClients,
  whatCleared,
  whatClearedOnLook,
} from './verify.ts';

/** The runners, as the line uses them (`runners/steps.ts`). */
export interface Steps {
  run(request: StepRequest): Promise<StepOutcome>;
  finish(workItem: string): Promise<void>;
  cancel(): Promise<void>;
}

/** The GitHub worker, as the line uses it (`github/worker-client.ts`). */
export interface GitHubPort {
  /** `on` names the work item, and the agent, the action is for, for the worker's log of it. */
  act<K extends ActionName>(action: K, repo: string, args: ActionArgs[K], on?: ActingFor): Promise<ActionResult<K>>;
  read<K extends ReadName>(read: K, repo: string, args: ReadArgs[K]): Promise<ReadResult<K>>;
}

export interface LineOptions {
  /** As the line's role (`factory_line`). */
  sql: Sql;
  events: Pick<EventWriter, 'append'>;
  steps: Steps;
  github: GitHubPort;
  log: Logger;
  /** The app's repository, as `owner/name`. */
  repo?: string;
  agents?: Agents;
  /** Who this worker is, as its leases name it: by default its host, which in the cluster is its pod. */
  me?: string;
  now?: () => Date;
  /** How often the gates and merges are read. */
  gatesEveryMs?: number;
  /** How often the line looks at the app's deploy pull request, to say what it carries. */
  deployEveryMs?: number;
  /** The app's Rollout, and Prometheus, for the line's watch of its releases; null, as by default, watches none. */
  release?: ReleaseWatchOptions | null;
  /** How often the line reads the app's release. */
  releaseEveryMs?: number;
  /** How often the line judges each improvement's work item at its flag's stage (`flags.ts`). */
  flagsEveryMs?: number;
  /**
   * Whether the line runs a dry run (LINE_MODE=dry-run): then it answers for the release of each merge the dry run
   * made, which never shipped, by its own word.
   */
  dryRun?: boolean;
  /** How long a dry run's release takes over each move: to start after the merge, each step, and its promotion. */
  dryRunReleaseMs?: number;
  /**
   * Where Verify looks: the probes worker, Prometheus, Loki and Tempo. A sense with none waits at Verify. Without
   * Tempo, the agreement check judges a missing log on the metrics and the log alone, and a wrong metric waits.
   */
  verify?: VerifyClients;
  /** The probes worker, which checks each improvement's flag at Off, Checks and Preview (`flags.ts`): none, they wait. */
  flagChecks?: FlagChecksPort | null;
  /**
   * The index of the pictures the probes worker took while each canary ran (`pictures/`), for the pages a verification
   * compares with the version before; null, as by default, compares none. The line's event writer must know the
   * pictures' artifacts (`IndexedArtifacts`).
   */
  pictures?: Pick<PictureIndex, 'of' | 'lookOf'> | null;
  /** How long the line waits to look again when a sense could not tell (`policy/release.ts`'s `verify`). */
  verifyEveryMs?: number;
  /** How long after the promotion a sense may go on not telling before the work item holds for Martin. */
  verifyWaitMs?: number;
  /**
   * False for a line that takes no work and only stops the steps in hand (the step API's) when the line stops.
   */
  takesWork?: boolean;
  /**
   * The most one work item may spend on models: the gateway's cap, from the same profile (policy/spend.ts), until
   * `settings` gives the one in force. Null, as by default, holds nothing for spend: the gateway still refuses the
   * calls, and the step fails.
   */
  workItemLimitUsd?: number | null;
  /**
   * Where each agent's calls go, as the gateway sends them, until `settings` says where they go now: a step on a local
   * model has longer bounds (`boundsOn`). By default, a provider that is not local.
   */
  providerOf?: (agent: LineAgent) => Provider;
  /** Martin's settings, read at each pass, so each step starts under those in force; null, as by default, for none. */
  settings?: LineSettings | null;
  /**
   * The one work item the line acts on, leaving every other as it is; null, as by default, for them all. Its default:
   * Martin's take, when one is in force, is what the line takes.
   */
  only?: string | null;
  /**
   * How many work items the line takes in all, counting every one it has taken, before it takes no more; null, as by
   * default, for no limit. Those already on it go on to their end. Its default, as `only` is.
   */
  take?: number | null;
}

type Provider = 'anthropic' | 'bedrock' | 'local';

/** Martin's settings, as the line reads them (`../settings.ts`): checked against policy, as the gateway checks them. */
export interface LineSettings {
  /** Where each agent's calls go now, and a work item's cap now. */
  now(): Promise<{ providerOf: (agent: LineAgent) => Provider; workItemLimitUsd: number }>;
  /** The effort a job's calls were sent at, if its agent was on Claude: the settings the gateway read for it. */
  effortOf(job: string, agent: LineAgent): Promise<Effort | undefined>;
  /**
   * Appends a spend hold only while the cap in force still holds the work item, read as the hold is appended, so a
   * save that raises the cap meanwhile is not missed; false, and nothing appended, when it no longer does.
   */
  holdForSpend?(hold: NewEvent, spentUsd: number): Promise<boolean>;
}

export const APP_REPOSITORY = 'the-roganator/cv-worlds-worst-website';

/** How long a work item stays leased for an action that is not a step. */
const ACTION_LEASE_SECONDS = 300;
/** A step's lease: its deadline, ten minutes to prepare, and some to spare. */
export const leaseFor = (deadlineSeconds: number) => deadlineSeconds + 900;
/** The lease for a handback's effects, renewed before them: a few writes in GitHub, each up to two minutes. */
const EFFECTS_LEASE_SECONDS = 900;
/** The lease for a look at Verify: the probes' half hour for a crawl run up to four times, and some to spare. */
const VERIFY_LEASE_SECONDS = 2700;
/** How long the line waits before trying a handback's effects again: doubling from 30 seconds, to 10 minutes. */
const retryAfterMs = (tries: number) => Math.min(30_000 * 2 ** (tries - 1), 600_000);

export class Line {
  readonly #o: Required<Omit<LineOptions, 'me'>>;
  readonly #queue: Queue;
  readonly #releases: Releases;
  /**
   * The steps in hand, by work item, with the stage each holds, and whether it is an agent's step on the local model
   * (not a kept handback's effects, which call no model).
   */
  readonly #inFlight = new Map<
    string,
    { stage: 'plan' | 'build' | 'review' | 'verify' | 'recheck'; local?: boolean; done: Promise<void> }
  >();
  /** When each work item whose last look, at Verify or again, could not tell may be looked at again. */
  readonly #lookAgainAt = new Map<string, number>();
  /** The open tickets the sense is looking at again beside a verified fix, which no other look or step may take up. */
  readonly #beside = new Set<string>();
  /** The latest real promotion, read once a pass; undefined until it is read. */
  #promotion: Promise<Promotion | undefined> | undefined;
  /** The work items in flight, with their specs' scopes and what each waits on, read once a pass, or after a wait. */
  #flight: Promise<InFlight[]> | undefined;
  #stopped = false;
  /** Aborted when the line stops, which stops every step started before, wherever it is. */
  #halt = new AbortController();
  #gatesReadAt = Number.NEGATIVE_INFINITY;
  /** The merged work items whose volume this worker has deleted, until a step makes one again. */
  readonly #volumeGone = new Set<string>();
  #deployReadAt = Number.NEGATIVE_INFINITY;
  #releaseReadAt = Number.NEGATIVE_INFINITY;
  readonly #flags: FlagPass;
  #flagsReadAt = Number.NEGATIVE_INFINITY;
  /** What the deploy pull request was last told it carries, with its number and commit; unknown after a start. */
  #described: string | undefined;
  /** Whether what dry runs left has been ended: by a live line, once; a dry run leaves it. */
  #dryRunsEnded: boolean;
  /** The work items whose dry run's leftovers could not be ended on the last try, which wait for the next. */
  readonly #dryRunLeft = new Set<string>();
  /** Martin's commands that a role not his appended: ignored, and each logged once. */
  readonly #ignored: IgnoredCommands;
  /** The one work item the line acts on, as this pass read Martin's take; until the first pass, the options'. */
  #only: string | null;
  /** What the line takes, as this pass read it. */
  #takes: Takes | undefined;
  /** Whether agents take new work, as this pass read Martin's switch. */
  #newWork = true;
  /** The settings in force, as this pass read them; until the first pass, the options'. */
  #inForce: Awaited<ReturnType<LineSettings['now']>> | undefined;

  constructor(options: LineOptions) {
    this.#o = {
      repo: APP_REPOSITORY,
      agents: AGENTS,
      now: () => new Date(),
      gatesEveryMs: 60_000,
      deployEveryMs: 60_000,
      release: null,
      releaseEveryMs: 30_000,
      flagsEveryMs: 30_000,
      dryRun: false,
      dryRunReleaseMs: 60_000,
      verify: {},
      flagChecks: null,
      pictures: null,
      verifyEveryMs: RELEASE.verify.everyMinutes * 60_000,
      verifyWaitMs: RELEASE.verify.waitHours * 60 * 60_000,
      takesWork: true,
      workItemLimitUsd: null,
      providerOf: () => 'anthropic',
      settings: null,
      only: null,
      take: null,
      ...options,
    };
    this.#ignored = new IgnoredCommands(this.#o.sql, this.#o.log);
    this.#queue = new Queue(options.sql, options.me ?? `line-${hostname()}`, {
      only: this.#o.only,
      take: this.#o.take,
    });
    this.#releases = new Releases({
      sql: this.#o.sql,
      events: this.#o.events,
      github: this.#o.github,
      repo: this.#o.repo,
      log: this.#o.log,
      now: this.#o.now,
      watch: this.#o.release,
      dryRun: this.#o.dryRun,
      dryRunEveryMs: this.#o.dryRunReleaseMs,
      only: this.#o.only,
    });
    this.#flags = new FlagPass({
      sql: this.#o.sql,
      events: this.#o.events,
      log: this.#o.log,
      now: this.#o.now,
      prometheus: this.#o.verify.prometheus ?? null,
      releaseEveryMs: this.#o.releaseEveryMs,
      probes: this.#o.flagChecks,
      github: this.#o.github,
      repo: this.#o.repo,
    });
    this.#dryRunsEnded = this.#o.dryRun;
    this.#only = this.#o.only;
  }

  /**
   * One pass: stops what is in hand if the line has stopped; otherwise reads the gates when they are due, takes a
   * ticket if there is room, and starts whatever each work item needs next. Steps carry on after it returns.
   */
  async tick(): Promise<void> {
    await this.#ignored.check();
    // Martin's controls in force now: what the line takes, and whether agents take new work. Read first, so the release
    // watch records by the take in force while the line is stopped too.
    if (this.#o.takesWork) this.#control(controlsInForce(await latestControls(this.#o.sql)));
    if (await lineStopped(this.#o.sql)) {
      if (!this.#stopped) {
        this.#stopped = true;
        this.#o.log.warn({ steps: [...this.#inFlight.keys()] }, 'the line stopped: deleting the steps in hand');
        // A step still preparing has no Jobs yet: the signal stops it before it makes them.
        this.#halt.abort();
        await this.#o.steps.cancel();
      }
      if (this.#o.takesWork) await this.#watchReleases(true);
      return;
    }
    if (this.#stopped) {
      this.#o.log.info('the line started again: carrying on from the last events');
      this.#halt = new AbortController();
    }
    this.#stopped = false;
    if (!this.#o.takesWork) return;
    // Every step this pass starts runs under the settings in force now: an append, Martin's settings among them, wakes it.
    if (this.#o.settings) this.#inForce = await this.#o.settings.now();
    this.#promotion = undefined;
    this.#flight = undefined;
    if (!this.#dryRunsEnded) {
      await this.#endDryRuns();
      // Without knowing what a dry run left, the line would carry on from it.
      if (!this.#dryRunsEnded && !this.#dryRunLeft.size) return;
    }
    if (this.#o.now().getTime() - this.#gatesReadAt >= this.#o.gatesEveryMs) {
      this.#gatesReadAt = this.#o.now().getTime();
      await this.#readGates();
    }
    if (this.#o.now().getTime() - this.#deployReadAt >= this.#o.deployEveryMs) {
      this.#deployReadAt = this.#o.now().getTime();
      await this.#deploy().catch((error: unknown) =>
        this.#o.log.warn({ err: error }, 'could not read the deploy pull request'),
      );
    }
    await this.#watchReleases(false);
    await this.#judgeFlags();
    await this.#reopen();
    // With agents taking no new work, no ticket comes onto the line.
    const taken = this.#newWork ? await this.#queue.admit() : undefined;
    if (taken) this.#o.log.info({ workItem: taken }, 'a work item came onto the line');
    for (const item of await this.#queue.free()) {
      if (this.#inFlight.has(item.workItem) || this.#dryRunLeft.has(item.workItem)) continue;
      await this.#advance(item).catch((error: unknown) =>
        this.#o.log.error({ workItem: item.workItem, err: error }, 'could not move a work item on'),
      );
    }
  }

  /**
   * Acts on Martin's controls from this pass on: what the line takes, his take or else its own default (`only`,
   * `take`), and whether agents take new work.
   */
  #control({ take, newWork }: Pick<Controls, 'take' | 'newWork'>): void {
    const takes = takesOf(take, { only: this.#o.only, take: this.#o.take });
    if (JSON.stringify(takes) !== JSON.stringify(this.#takes) || newWork !== this.#newWork) {
      this.#o.log.info({ ...takes, newWork }, 'the line acts on what Martin set it to take');
    }
    this.#only = takes.only;
    this.#takes = takes;
    this.#newWork = newWork;
    this.#queue.takes(takes);
    this.#releases.actOn(takes.only);
  }

  /** Reads the app's releases when they are due: the Rollout alone while the line is stopped. */
  async #watchReleases(stopped: boolean): Promise<void> {
    if (this.#o.now().getTime() - this.#releaseReadAt < this.#o.releaseEveryMs) return;
    this.#releaseReadAt = this.#o.now().getTime();
    await this.#releases.pass({ dryRun: !stopped });
  }

  /** Judges each improvement's work item at its flag's stage when it is due (`flags.ts`), with `only` as this pass read it. */
  async #judgeFlags(): Promise<void> {
    if (this.#o.now().getTime() - this.#flagsReadAt < this.#o.flagsEveryMs) return;
    this.#flagsReadAt = this.#o.now().getTime();
    await this.#flags
      .pass(this.#only)
      .catch((error: unknown) => this.#o.log.warn({ err: error }, 'could not judge the flags'));
  }

  /**
   * Ends what dry runs left on the line (`dryRunLeft`), as a live line starts. A work item it cannot end now, because
   * GitHub or the store failed or another worker holds it, is tried again on the next pass, and until then the line
   * reads no gates and starts nothing for it. The passes stop trying once nothing is left. A reopened work item waiting
   * to come back into Plan is left to that: taking it back forgets a dry run's issue, and opens a new one.
   */
  async #endDryRuns(): Promise<void> {
    const items = await this.#queue.all().catch((error: unknown) => {
      this.#o.log.warn({ err: error }, 'could not read what dry runs left');
      return undefined;
    });
    if (!items) return;
    this.#dryRunLeft.clear();
    for (const item of items) {
      if (item.waiting) continue;
      await this.#endDryRun(item).catch((error: unknown) => {
        this.#dryRunLeft.add(item.workItem);
        this.#o.log.warn({ workItem: item.workItem, err: error }, 'could not end what a dry run left');
      });
    }
    this.#dryRunsEnded = this.#dryRunLeft.size === 0;
  }

  async #endDryRun(item: QueueItem): Promise<void> {
    const { workItem } = item;
    const { events } = await this.#events(workItem);
    const left = dryRunLeft(events, item.issue);
    if (!left) return;
    if (left.end === 'reopen') {
      // As triage reopens a ticket whose signal came back: the line takes it back into Plan on this pass (`#reopen`).
      const first = await this.#firstSignal(workItem);
      if (!first) {
        this.#o.log.warn({ workItem }, 'a ticket a dry run verified has no signal to reopen it on');
        return;
      }
      await this.#append(workItem, [
        {
          type: 'work-item.reopened',
          actor: 'factory',
          summary: 'Reopened: the dry run’s fix never shipped',
          payload: {
            sense: first.sense,
            check: cutAt(first.check, 80),
            route: first.route,
            version: left.against,
            reason: 'A dry run verified it, and its fix never shipped: the line, running live, takes it again',
            dryRun: true,
          },
        },
      ]);
      this.#o.log.info({ workItem }, 'reopened a ticket a dry run verified');
      return;
    }
    if (this.#inFlight.has(workItem)) throw new Error('a step is in hand');
    // An improvement the dry run handed over has ended on the line: it is held all the same, so no other line ends it.
    const claimed = await this.#queue.claim(workItem, ACTION_LEASE_SECONDS, { ended: item.stage === 'ended' });
    if (!claimed) throw new Error('another worker holds it');
    const improvement = fold(events).request !== undefined;
    try {
      // Read again under the lease: another line may have ended it before this one held it.
      const still = dryRunLeft((await this.#events(workItem)).events, claimed.issue);
      if (still?.end !== 'close') return;
      const reason = {
        merge: `A dry run merged its ${improvement ? 'improvement' : 'fix'}, which never shipped: the line, running live, closed it`,
        'pull-request': 'Its pull request was a dry run’s, which GitHub never had: the line, running live, closed it',
        issue: 'Its issue was a dry run’s, which GitHub never had: the line, running live, closed it',
      }[still.why];
      // A dry run's issue is one GitHub never had, as its pull request is.
      if (claimed.issue && claimed.issue < DRY_RUN_NUMBERS_FROM) {
        // An issue that is gone, or that the App may not change, has nothing to close.
        await closeIssue(
          this.#o.github,
          this.#o.repo,
          {
            number: claimed.issue,
            reason: 'not_planned',
            comment: [
              `${reason}.`,
              '',
              improvement
                ? `The factory’s work item #${workItem} is closed with no change: Martin asks for it again if he still wants it.`
                : `The factory’s work item #${workItem} is closed with no change: the next signal of this defect opens a fresh ticket.`,
            ].join('\n'),
          },
          workItem,
          this.#o.log,
        );
      }
      await this.#append(workItem, [
        {
          type: 'work-item.closed',
          actor: 'factory',
          summary: 'Closed: the dry run’s work never reached GitHub',
          payload: { outcome: 'no-change', reason },
        },
      ]);
      this.#o.log.info({ workItem, why: still.why }, 'closed a work item a dry run left');
    } finally {
      await this.#release(workItem);
    }
  }

  /**
   * Takes each reopened work item back into Plan, once its issue is open again, saying what came back. One whose issue
   * GitHub cannot open for now stays where it is, and is tried again on the next pass. One whose issue is gone, or
   * that the App may no longer open, comes back without it, and the line opens a new one as it enters Plan.
   */
  async #reopen(): Promise<void> {
    for (const item of await this.#queue.reopened()) {
      const { workItem } = item;
      if (this.#inFlight.has(workItem)) continue;
      let forgetIssue = false;
      try {
        const reopened = fold((await this.#events(workItem)).events).reopened.at(-1);
        // A dry run's issue is one GitHub never had: the line opens a new one.
        if (item.issue && item.issue >= DRY_RUN_NUMBERS_FROM) forgetIssue = true;
        else if (item.issue && reopened) {
          const comment = reopeningComment(reopened, workItem);
          await this.#o.github
            .act('reopenIssue', this.#o.repo, { number: item.issue, comment }, { workItem })
            .catch((error) => {
              if (!issueGone(error)) throw error;
              this.#o.log.warn({ workItem, issue: item.issue, err: error }, 'the issue cannot be reopened');
              forgetIssue = true;
            });
        }
        if (await this.#queue.revive(workItem, { forgetIssue })) {
          this.#o.log.info({ workItem, issue: item.issue }, 'a reopened work item came back onto the line');
        }
      } catch (error) {
        this.#o.log.warn({ workItem, err: error }, 'could not take a reopened work item back onto the line');
      }
    }
  }

  /** Waits for the steps in hand to end. */
  async idle(): Promise<void> {
    while (this.#inFlight.size) await Promise.all([...this.#inFlight.values()].map((s) => s.done));
  }

  /**
   * Runs until aborted, woken by every append (the line stopping or starting, a ticket opening) and every fifteen
   * seconds. Aborting stops the steps in hand, as stopping the line does, and lets go of every lease.
   */
  async run(abort: AbortSignal): Promise<void> {
    let wake = Promise.withResolvers<void>();
    const nudge = () => wake.resolve();
    const listening = await this.#o.sql.listen('events', nudge);
    abort.addEventListener('abort', nudge);
    // Every count from 0, so the first of each kind since the line started is counted: only on a line that takes
    // work, so a line that is off reads as nothing rather than as a quiet line.
    if (this.#o.takesWork) {
      zeroCounts({ providerOf: this.#o.providerOf, dryRun: this.#o.dryRun });
      await sendCounts();
    }
    // The stages as the store has them, while the line runs: with LINE_MODE off, nothing moves them. And each hold
    // that waits for Martin, and what the line is carrying against its limits, from the store too.
    const unobserved = this.#o.takesWork
      ? [observeStages(this.#o.sql), observeHolds(this.#o.sql), observeTaken(this.#o.sql, () => this.#carrying())]
      : [];
    const unobserve = () => {
      for (const stop of unobserved) stop();
    };
    try {
      while (!abort.aborted) {
        await this.tick().catch((error: unknown) => this.#o.log.error({ err: error }, 'a pass of the line failed'));
        const timer = setTimeout(nudge, 15_000);
        await wake.promise;
        clearTimeout(timer);
        wake = Promise.withResolvers<void>();
      }
    } finally {
      unobserve();
      await listening.unlisten();
      if (this.#o.takesWork) {
        this.#halt.abort();
        await this.#o.steps.cancel();
        await this.idle();
        await this.#queue.releaseAll();
      }
    }
  }

  /** Does what a work item needs next, until it is waiting or a step has started. */
  async #advance(first: QueueItem): Promise<void> {
    let item: QueueItem | undefined = first;
    // A few quick actions in a row (open the issue, then start the planner), never a loop without end.
    for (let actions = 0; item && actions < 5; actions++) {
      // A ticket the line took while the sense looked at it beside another's fix: the look's to finish first.
      if (this.#beside.has(item.workItem)) return;
      const { events, last } = await this.#events(item.workItem);
      const { stage, next } = decide(events, await this.#facts(item, events));
      if (fold(events).merged) await this.#dropVolume(item.workItem);
      // A kept handback is for the step the work item still needs, with nothing appended since; any other is over.
      const pending = item.effects;
      const kept =
        next.do === 'step' && pending?.agent === next.agent && pending.round === next.round && pending.since === last;
      if (pending && !kept) {
        await this.#queue.drop(item.workItem);
        item = { ...item, effects: null };
      }
      const rechecking = [...this.#inFlight.values()].some((s) => s.stage === 'recheck');
      if (
        next.do === 'wait' ||
        (next.do === 'verify' && !this.#lookDue(item.workItem)) ||
        (next.do === 'recheck' && (rechecking || !this.#lookDue(item.workItem)))
      ) {
        if (stage !== item.stage && (await this.#queue.claim(item.workItem, ACTION_LEASE_SECONDS))) {
          await this.#queue.release(item.workItem, stage);
        }
        return;
      }
      if (next.do === 'verify') {
        const claimed = await this.#queue.claim(item.workItem, VERIFY_LEASE_SECONDS);
        if (!claimed) return;
        await this.#queue.move(item.workItem, stage);
        const workItem = item.workItem;
        const look = { [A.workItem]: workItem, [A.release]: next.release.release };
        const done = inSpan('verify', look, () => this.#look(workItem, next.release, this.#halt.signal))
          .catch((error: unknown) => {
            this.#lookAgainAt.set(workItem, this.#o.now().getTime() + this.#o.verifyEveryMs);
            this.#o.log.warn({ workItem, err: error }, 'Verify could not look: it looks again later');
          })
          .then(() => this.#release(workItem))
          .catch((error: unknown) =>
            this.#o.log.error({ workItem, err: error }, 'could not let go of a work item after a look'),
          )
          .finally(() => this.#inFlight.delete(workItem));
        this.#inFlight.set(workItem, { stage: 'verify', done });
        return;
      }
      if (next.do === 'recheck') {
        const claimed = await this.#queue.claim(item.workItem, VERIFY_LEASE_SECONDS);
        if (!claimed) return;
        await this.#queue.move(item.workItem, stage);
        const workItem = item.workItem;
        const { for: occasion } = next;
        const done = inSpan('recheck', { [A.workItem]: workItem }, () =>
          this.#recheck(workItem, occasion, fold(events), this.#halt.signal),
        )
          .catch((error: unknown) => {
            this.#lookAgainAt.set(workItem, this.#o.now().getTime() + this.#o.verifyEveryMs);
            this.#o.log.warn({ workItem, err: error }, 'could not look again: it looks again later');
          })
          .then(() => this.#release(workItem))
          .catch((error: unknown) =>
            this.#o.log.error({ workItem, err: error }, 'could not let go of a work item after a look'),
          )
          .finally(() => this.#inFlight.delete(workItem));
        this.#inFlight.set(workItem, { stage: 'recheck', done });
        return;
      }
      if (next.do === 'step') {
        // One step at a time in each of Plan, Build and Review.
        if ([...this.#inFlight.values()].some((s) => s.stage === STAGE_OF[next.agent])) return;
        // With agents taking no new work, none starts; a kept handback's effects, of a step already run, go on.
        if (!kept && !this.#newWork) return;
        // And one at a time on the local model, which answers one prediction at a time. A kept handback calls no model.
        const provider = this.#providerOf(next.agent);
        const localBusy = () => provider === 'local' && [...this.#inFlight.values()].some((s) => s.local);
        if (!kept && localBusy()) {
          this.#o.log.debug({ workItem: item.workItem, agent: next.agent }, 'a step waits for the local model');
          return;
        }
        if (kept && pending?.retryAt && Date.parse(pending.retryAt) > this.#o.now().getTime()) return;
        // Behind a cap the gateway refuses every call, so a step would only fail: it waits for the cap to clear.
        if (!kept) {
          const cap = capOn(await capsInForce(this.#o.sql), provider);
          if (cap) {
            this.#o.log.debug({ workItem: item.workItem, agent: next.agent, cap: cap.reason }, 'a step waits at a cap');
            return;
          }
        }
        const seconds = kept ? EFFECTS_LEASE_SECONDS : leaseFor(this.#bounds(next.agent).deadlineSeconds);
        const claimed = await this.#queue.claim(item.workItem, seconds);
        if (!claimed) return;
        const workItem = item.workItem;
        // A kept handback dropped since it was read leaves the agent's step to run again, on its model.
        const effects = kept ? claimed.effects : null;
        if (!effects && (localBusy() || !this.#newWork)) {
          await this.#queue.release(workItem, item.stage);
          return;
        }
        // Then the step's lease must outlast its deadline, not the effects'.
        if (
          kept &&
          !effects &&
          !(await this.#queue.claim(workItem, leaseFor(this.#bounds(next.agent).deadlineSeconds)))
        ) {
          return;
        }
        const local = !effects && provider === 'local';
        await this.#queue.move(workItem, stage);
        this.#volumeGone.delete(workItem);
        const state = fold(events);
        const { agent, round } = next;
        const done = (
          effects
            ? inSpan('step effects', { [A.workItem]: workItem, [A.agent]: agent, [A.job]: effects.job }, () =>
                this.#effects(claimed, state, effects).catch((error: unknown) => {
                  countStep(agent, providerOfStep(effects.called) ?? provider, 'errored');
                  throw error;
                }),
              ).finally(() => this.#release(workItem))
            : inSpan('step', { [A.workItem]: workItem, [A.agent]: agent }, () =>
                this.#step(claimed, agent, round, state, last, this.#halt.signal),
              )
        )
          .catch((error: unknown) => this.#o.log.error({ workItem, err: error }, 'a step could not be recorded'))
          .finally(() => this.#inFlight.delete(workItem));
        this.#inFlight.set(workItem, { stage: STAGE_OF[next.agent], local, done });
        return;
      }
      const claimed = await this.#queue.claim(item.workItem, ACTION_LEASE_SECONDS);
      if (!claimed) return;
      let acted: boolean | undefined;
      try {
        acted = await this.#act(claimed, next, fold(events));
      } catch (error) {
        await this.#release(item.workItem);
        throw error;
      }
      if (acted === false) {
        await this.#release(item.workItem);
        return;
      }
      if (next.do === 'finish' || next.do === 'hand-over') {
        await this.#queue.release(item.workItem, 'ended');
        return;
      }
      await this.#release(item.workItem);
      item = await this.#queue.get(item.workItem);
    }
  }

  /**
   * Deletes a merged work item's volume, once: a work item waiting for a release would otherwise hold a share of the
   * runners' quota (`deploy/base/runners/quota.yaml`) for as long as it waits. A failure is tried again next pass.
   */
  async #dropVolume(workItem: string): Promise<void> {
    if (this.#volumeGone.has(workItem)) return;
    try {
      await this.#o.steps.finish(workItem);
      this.#volumeGone.add(workItem);
    } catch (error) {
      this.#o.log.warn({ workItem, err: error }, 'could not delete a merged work item’s volume');
    }
  }

  /**
   * Lets go of a work item, at the stage its events now put it in. Never at its end: only finishing ends a work item,
   * once its volume has gone, so a work item that ended while a step was in hand is still taken up and finished.
   */
  async #release(workItem: string): Promise<void> {
    const item = await this.#queue.get(workItem);
    if (!item) return;
    const { events } = await this.#events(workItem);
    const { stage } = decide(events, await this.#facts(item, events));
    await this.#queue.release(workItem, stage === 'ended' ? item.stage : stage);
  }

  /**
   * An action that is not a step: quick, and done before the next. Gives back false when it did nothing, and the
   * work item waits for the line's next read of GitHub.
   */
  async #act(
    item: QueueItem,
    next: Exclude<Next, { do: 'step' | 'wait' | 'verify' | 'recheck' }>,
    state: WorkItemState,
  ): Promise<boolean | undefined> {
    const { workItem } = item;
    switch (next.do) {
      case 'open-issue': {
        const issue = state.request
          ? await this.#openImprovementIssue(workItem)
          : await this.#openIssue(workItem, state);
        await this.#queue.setIssue(workItem, issue);
        this.#o.log.info({ workItem, issue }, 'opened the work item’s issue');
        return;
      }
      case 'hand-over': {
        // Its volume first, gone at its merge as a rule: an ended row is never taken up again, so one that cannot be
        // deleted now keeps the row where it is, to try again on a later pass, before anything is said.
        await this.#dropVolume(workItem);
        if (!this.#volumeGone.has(workItem)) return false;
        // The row ends just after, so a crash, or a store that fails, in between asks again: the GitHub worker says
        // nothing an issue says already, word for word. An issue that is gone, or that the App may not change, leaves
        // nothing to say, and the hand-over goes on.
        if (item.issue) {
          const flag = state.spec?.flag;
          await this.#o.github
            .act(
              'comment',
              this.#o.repo,
              { number: item.issue, body: handOverComment(workItem, flag, next.release.version) },
              { workItem },
            )
            .catch((error) => {
              if (!issueGone(error)) throw error;
              this.#o.log.warn({ workItem, issue: item.issue, err: error }, 'the issue cannot be commented on');
            });
        }
        this.#o.log.info({ workItem, release: next.release.release }, 'handed a released improvement to its flag');
        return;
      }
      case 'return': {
        const { do: _, ...returned } = next;
        // A pull request ready for review (the describer readied it) goes back to draft before the work goes back to
        // Build, so that GitHub will not merge a round the reviewer has not seen. GitHub says whether it is ready, not
        // the events: whoever readied it, it goes back.
        if (next.to === 'build' && state.pullRequest) {
          const { number } = state.pullRequest;
          const pr = await this.#o.github.read('pullRequest', this.#o.repo, { number });
          // Merged or closed since the line last read it: there is nothing to send back. The next read of GitHub
          // records the merge, and the work item goes on to Release, or the close, which ends it.
          if (pr.state !== 'open') return false;
          if (!pr.draft) {
            await this.#o.github.act(
              'convertToDraft',
              this.#o.repo,
              { pullRequest: { number, url: '', nodeId: pr.nodeId } },
              { workItem },
            );
          }
        }
        // Back to Plan, the pass starts afresh, and its coder's first round with it.
        const payload = next.to === 'plan' ? returned : { ...returned, round: state.round + 1 };
        await this.#append(workItem, [
          {
            type: 'work.returned',
            actor: next.from === 'review' ? 'reviewer' : 'factory',
            // The console draws the same words, from the payload, in the return's pill on the line.
            summary: `#${workItem} · ${'round' in payload ? `round ${payload.round}` : 'to Plan'} · ${returnWords(payload)}`,
            payload,
          },
        ]);
        await this.#queue.moved(workItem);
        // The coder of a fresh pass starts a session of its own: the old one worked on a change that has merged.
        if (next.to === 'plan') await this.#queue.setSession(workItem, null);
        return;
      }
      case 'accept': {
        // The reply says when he gave the answer that approved it, so one asked for again after a failure reads the
        // same, and is made once.
        const number = state.pullRequest?.number;
        const at = await this.#answeredAt(workItem, next.answer);
        if (number === undefined || !at) throw new Error('an accepted review has no pull request, or no answer');
        const accepted = acceptedFindings(state);
        const threads = acceptedThreads(state.reviews, accepted, at, next.words);
        const resolved = await resolveThreads(threads, (batch) =>
          this.#o.github.act('resolveThreads', this.#o.repo, { number, threads: batch }, { workItem }),
        );
        const findings = accepted.blocking.length;
        const suggestions = accepted.suggestions.length;
        const what = acceptedWords(findings, suggestions);
        await this.#append(workItem, [
          {
            type: 'review.accepted',
            actor: 'factory',
            summary: resolved
              ? `Martin accepted review ${next.review} of PR #${number}: ${what} answered and resolved`
              : `Martin accepted review ${next.review} of PR #${number}: GitHub refused to resolve ${what.replace(/ (is|are)$/, '')}, which are left for him`,
            payload: {
              pullRequest: number,
              review: next.review,
              findings,
              suggestions,
              ...(resolved ? {} : { refused: true }),
            },
          },
        ]);
        return;
      }
      case 'hold': {
        const draft = holdDraft('factory', next.hold);
        const { spentUsd } = next.hold;
        const guard = this.#o.settings?.holdForSpend;
        if (next.hold.cause === 'spend' && spentUsd !== undefined && guard) {
          // The cap was raised since this pass read it: no hold, and the next pass decides again under the new one.
          if (!(await guard(asEvent(workItem, draft, this.#o.now().toISOString()), spentUsd))) return false;
          countRecorded([draft]);
        } else await this.#append(workItem, [draft]);
        await this.#queue.moved(workItem);
        return;
      }
      case 'wait-on': {
        const reason = waitReason(next.on, next.files);
        await this.#append(workItem, [
          {
            type: 'wait.started',
            actor: 'factory',
            summary: reason,
            payload: { on: next.on, files: next.files, reason },
          },
        ]);
        // Another work item checked after this one, in this pass, must see that this one waits.
        this.#flight = undefined;
        await this.#queue.moved(workItem);
        this.#o.log.info({ workItem, on: next.on, files: next.files }, 'a spec that overlaps waits');
        return;
      }
      case 'close':
        // The issue goes with it; closing one already closed changes nothing, and one that is gone, or that the App may
        // not change, has nothing to close.
        if (item.issue) {
          await closeIssue(
            this.#o.github,
            this.#o.repo,
            { number: item.issue, reason: 'not_planned' },
            workItem,
            this.#o.log,
          );
        }
        await this.#append(workItem, [
          {
            type: 'work-item.closed',
            actor: 'factory',
            summary: next.merged ? 'Closed after its merge, as Martin answered' : 'Closed unmerged, as Martin answered',
            payload: { outcome: 'no-change', reason: next.reason },
          },
        ]);
        return;
      case 'verified': {
        // The issue first, with what cleared it: closing one already closed changes nothing, and says nothing again;
        // one that is gone, or that the App may not change, has nothing to close.
        const { rechecked } = next;
        const reason = rechecked ? whatClearedOnLook(rechecked) : whatCleared(next.verification, next.answer);
        if (item.issue) {
          await closeIssue(
            this.#o.github,
            this.#o.repo,
            {
              number: item.issue,
              reason: 'completed',
              comment: closingComment(next.verification, workItem, next.answer, rechecked),
            },
            workItem,
            this.#o.log,
          );
        }
        // A pull request for a defect that went another way is left for nobody to merge. Once it is closed, a crash
        // before the close below is caught as the gates are read: the pull request reads as closed unmerged, and the
        // clearance that stands closes the work item as verified.
        if (rechecked && state.pullRequest && !state.merged) {
          await this.#o.github.act(
            'closePullRequest',
            this.#o.repo,
            { number: state.pullRequest.number, comment: closingPullComment(rechecked, workItem) },
            { workItem },
          );
        }
        const summary = rechecked
          ? CLEARED_ON_LOOK[rechecked.for]
          : next.verification?.dryRun
            ? 'Verified by the dry run’s word, and closed'
            : 'Verified, and closed';
        await this.#append(workItem, [
          {
            type: 'work-item.closed',
            actor: 'factory',
            summary,
            payload: { outcome: 'verified', reason: cutTo(reason, 200) },
          },
        ]);
        this.#lookAgainAt.delete(workItem);
        return;
      }
      case 'finish':
        await this.#o.steps.finish(workItem);
        this.#o.log.info({ workItem }, 'the work item is over');
        return;
    }
  }

  /** Whether a work item at Verify may be looked at: never twice at once, and not before a look that could not tell. */
  #lookDue(workItem: string): boolean {
    if (this.#inFlight.has(workItem)) return false;
    return (this.#lookAgainAt.get(workItem) ?? Number.NEGATIVE_INFINITY) <= this.#o.now().getTime();
  }

  /**
   * One look at Verify, by the sense of the ticket's first signal, at the version the stable Service runs. What it
   * found is appended, unless the line stopped meanwhile: a look is read-only, and the next start looks again.
   */
  async #look(workItem: string, promoted: PayloadOf<'release.promoted'>, signal: AbortSignal): Promise<void> {
    const target = await this.#target(workItem, promoted);
    const now = this.#o.now();
    const first = await this.#firstSignal(workItem);
    let found: Look;
    try {
      found = await look(first, target, {
        ...this.#o.verify,
        now,
        dryRun: this.#o.dryRun,
        signal,
      });
    } catch (error) {
      found = { kind: 'wait', why: `the sense could not be asked: ${messageOf(error)}` };
    }
    trace.getActiveSpan()?.setAttribute(A.outcome, found.kind === 'finished' ? found.verification.outcome : found.kind);
    if (signal.aborted) return;
    // A release promoted while the sense looked: what it saw was of a version no longer stable. Look again at once.
    if (found.kind === 'finished' && !target.dryRun) {
      const stable = await this.#target(workItem, promoted);
      if (stable.version !== target.version) {
        this.#o.log.info({ workItem, looked: target.version, stable: stable.version }, 'a release came between');
        return;
      }
    }
    // Read only when something is appended: a look that cannot tell yet comes round every few minutes. A hold
    // carries the screenshots alone, so only a verification names the other work items the release carried.
    const shown = (named = false) => this.#pictures(workItem, promoted, first, named);
    switch (found.kind) {
      case 'wait': {
        const hours = this.#o.verifyWaitMs / 3_600_000;
        if (now.getTime() - target.at.getTime() < this.#o.verifyWaitMs) {
          this.#lookAgainAt.set(workItem, now.getTime() + this.#o.verifyEveryMs);
          this.#o.log.info({ workItem, version: target.version, why: found.why }, 'Verify cannot tell yet');
          return;
        }
        // A sense that still cannot tell long after the release may never: Martin judges, told why.
        const reason = cutTo(`Verify could not tell in ${hours} hours after the release: ${found.why}`, 300);
        await this.#append(workItem, [
          {
            ...holdDraft('factory', { stage: 'verify', kind: 'held', cause: 'verify', reason }),
            artifacts: (await shown()).artifacts,
          },
        ]);
        await this.#queue.moved(workItem);
        return;
      }
      case 'hold':
        // Martin judges with the pictures before him: every page on the version before and on the fix's.
        await this.#append(workItem, [
          {
            ...holdDraft('factory', {
              stage: 'verify',
              kind: 'approval',
              cause: 'verify',
              reason: cutTo(found.reason, 300),
            }),
            artifacts: (await shown()).artifacts,
          },
        ]);
        await this.#queue.moved(workItem);
        return;
      case 'finished': {
        const { pages, artifacts } = await shown(true);
        const v = { ...found.verification, pages };
        const said = v.dryRun ? 'by the dry run’s word' : `by the ${v.sense ?? 'sense'}`;
        await this.#append(workItem, [
          {
            type: 'verification.finished',
            actor: v.sense && v.sense !== 'report' && !v.dryRun ? v.sense : 'factory',
            summary: `${v.outcome === 'cleared' ? 'Cleared' : 'Persists'} on ${v.version?.slice(0, 7)}, ${said}`,
            payload: v,
            artifacts,
          },
        ]);
        this.#lookAgainAt.delete(workItem);
        await this.#queue.moved(workItem);
        this.#o.log.info({ workItem, outcome: v.outcome, sense: v.sense, version: v.version }, 'verified a release');
        if (v.outcome === 'cleared' && !v.dryRun) await this.#besideFix(workItem, first, signal);
        return;
      }
    }
  }

  /**
   * The release to verify a work item's fix on: the latest promoted since the one that carried it, which the stable
   * Service runs and which carries the fix too, or the dry run's own.
   */
  async #target(workItem: string, promoted: PayloadOf<'release.promoted'>): Promise<Target> {
    const { sql } = this.#o;
    const [own] = await sql<{ seq: string; ts: Date }[]>`
      select seq, ts from events
      where work_item = ${workItem} and type = 'release.promoted' and payload->>'release' = ${promoted.release}
      order by seq desc limit 1`;
    if (!own) throw new Error(`Work item ${workItem} has no promotion of ${promoted.release}`);
    if (promoted.dryRun) {
      return { against: promoted.previous, dryRun: true, version: promoted.version, at: new Date(own.ts) };
    }
    const latest = await this.#latestPromotion(own.seq);
    return this.#stableTarget(
      latest ?? { ...promoted, at: new Date(own.ts), seq: own.seq },
      // The version before the fix: what the release that carried it replaced.
      promoted.previous,
    );
  }

  /** The latest real promotion, on any work item or the line, at or after `from` if given: what the stable Service runs. */
  async #latestPromotion(from?: string): Promise<Promotion | undefined> {
    const [latest] = await this.#o.sql<(Omit<Promotion, 'at'> & { at: Date })[]>`
      select payload->>'version' as version, payload->>'release' as release, payload->>'previous' as previous,
             (payload->>'watched')::boolean is not false as watched, ts as at, seq from events
      where type = 'release.promoted' and (payload->>'dryRun')::boolean is not true
        ${from === undefined ? this.#o.sql`` : this.#o.sql`and seq >= ${from}`}
      order by seq desc limit 1`;
    return latest && { ...latest, at: new Date(latest.at) };
  }

  /**
   * A real release as a sense looks at it, with the canary's analysis of its last step, on whichever work item (or
   * the line) has it: a release found live has none. `against` is the version the look compares with.
   */
  async #stableTarget(promotion: Promotion, against: string): Promise<Target> {
    const { release, watched } = promotion;
    const [step] = watched
      ? await this.#o.sql<{ measures: PayloadOf<'canary.stepped'>['analysis']['measures'] }[]>`
          select payload->'analysis'->'measures' as measures from events
          where type = 'canary.stepped' and payload->>'release' = ${release}
          order by seq desc limit 1`
      : [];
    return {
      against,
      dryRun: false,
      version: promotion.version,
      at: promotion.at,
      ...(watched ? { analysis: { release, against: promotion.previous, measures: step?.measures ?? [] } } : {}),
    };
  }

  /**
   * One look again at a work item's signal, by the sense of the ticket's first signal, at the version the stable
   * Service runs, which did not carry its fix (`look`, as at Verify, with no pictures). What it found is appended,
   * unless the line stopped meanwhile or a release came between. A look that cannot tell is tried again later; at the
   * end of a wait, or as the line takes a ticket, after the policy's wait from the wait's end or the release it looked
   * at, it is recorded as unsure, and the work item goes on, to Build or Plan. Beside another's verified fix (`fix`),
   * only what cleared or persists is recorded: a ticket the sense could not tell of is looked at again as it is taken.
   */
  async #recheck(
    workItem: string,
    occasion: PayloadOf<'signal.rechecked'>['for'],
    state: WorkItemState,
    signal: AbortSignal,
  ): Promise<void> {
    const now = this.#o.now();
    const first = await this.#firstSignal(workItem);
    const sense = SENSES.find((one) => one === first?.sense);
    const base = {
      for: occasion,
      ...(sense ? { sense } : {}),
      check: cutAt(first?.check ?? 'the ticket’s signal', 120),
    };
    const promotion = await this.#latestPromotion();
    if (!promotion) {
      if (occasion !== 'wait') return;
      const why = 'no release of the app has been recorded';
      return this.#rechecked(workItem, { ...base, outcome: 'unsure', carried: [], why });
    }
    const target = await this.#stableTarget(promotion, promotion.previous);
    let found: Look;
    try {
      found = await look(first, target, { ...this.#o.verify, now, dryRun: this.#o.dryRun, signal });
    } catch (error) {
      found = { kind: 'wait', why: `the sense could not be asked: ${messageOf(error)}` };
    }
    trace.getActiveSpan()?.setAttribute(A.outcome, found.kind === 'finished' ? found.verification.outcome : found.kind);
    if (signal.aborted) return;
    // A release promoted while the sense looked: what it saw was of a version no longer stable. Look again.
    if (found.kind === 'finished' && (await this.#latestPromotion())?.release !== promotion.release) {
      this.#o.log.info({ workItem, looked: promotion.version }, 'a release came between');
      return;
    }
    if (occasion === 'fix' && found.kind !== 'finished') return;
    const looked = {
      release: promotion.release,
      version: promotion.version,
      against: promotion.previous,
      ...(await this.#carriedSince(workItem, promotion)),
    };
    switch (found.kind) {
      case 'finished': {
        const { outcome, evidence } = found.verification;
        if (outcome === 'cleared' || outcome === 'persists') {
          return this.#rechecked(workItem, { ...base, ...looked, outcome, ...(evidence ? { evidence } : {}) });
        }
        return;
      }
      case 'hold':
        return this.#rechecked(workItem, { ...base, ...looked, outcome: 'unsure', why: cutTo(found.reason, 200) });
      case 'wait': {
        // A wait goes on for no longer than the policy's after the work it waited on ended, and a take's after the
        // release it looked at; a hold's look stops there.
        const ended =
          occasion === 'wait' ? await this.#waitEnded(state) : occasion === 'take' ? promotion.at.getTime() : undefined;
        if (ended === undefined || now.getTime() - ended < this.#o.verifyWaitMs) {
          this.#lookAgainAt.set(workItem, now.getTime() + this.#o.verifyEveryMs);
          this.#o.log.info({ workItem, version: target.version, why: found.why }, 'a look again cannot tell yet');
          return;
        }
        const hours = this.#o.verifyWaitMs / 3_600_000;
        const said = cutTo(`the sense could not tell in ${hours} hours: ${found.why}`, 200);
        return this.#rechecked(workItem, { ...base, ...looked, outcome: 'unsure', why: said });
      }
    }
  }

  /**
   * As Verify clears a fix, the sense looks again at each open ticket of the same sense and symptom that the line has
   * not taken, whose signal was last seen on a version before the one it verified: a fix may clear more than its own
   * ticket, as one change can fix one defect on several pages. One that cleared closes as verified, naming the fixes
   * the releases since carried; one still seen waits to be taken, and is not looked at again for that release.
   */
  async #besideFix(workItem: string, first: FirstSignal | undefined, signal: AbortSignal): Promise<void> {
    // A line of one leaves every other work item as it is.
    if (this.#only !== null || !first?.symptom || first.sense === 'report' || first.sense === 'planner') return;
    const promotion = await this.#latestPromotion();
    if (!promotion) return;
    const { sql } = this.#o;
    const rows = await sql<{ work_item: string }[]>`
      select t.work_item from events t
      cross join lateral (
        select s.payload from events s
        where s.work_item = t.work_item and s.type = 'signal.received' order by s.seq limit 1
      ) opener
      where t.type = 'ticket.opened' and not t.sample and t.work_item <> ${workItem}
        and opener.payload->>'sense' = ${first.sense} and opener.payload->>'symptom' = ${first.symptom}
        and ${lastEnd(sql, 't.work_item')} is distinct from 'work-item.closed'
        and not exists (select 1 from line l where l.work_item = t.work_item)
      order by t.seq limit ${BESIDE_A_FIX}`;
    const stable = { release: promotion.release, version: promotion.version, due: true };
    for (const { work_item: other } of rows) {
      if (signal.aborted) return;
      const before = fold((await this.#events(other)).events);
      if (!atTake(before) || !lookDue(before, stable)) continue;
      this.#beside.add(other);
      try {
        await inSpan('recheck', { [A.workItem]: other }, () => this.#recheck(other, 'fix', before, signal));
        const after = fold((await this.#events(other)).events);
        // Taken meanwhile, the line closes it on the clearance as it comes to it.
        if (!after.cleared || after.closed || (await this.#queue.get(other))) continue;
        await this.#act(untaken(other), { do: 'verified', verification: undefined, rechecked: after.cleared }, after);
        this.#o.log.info({ workItem, also: other }, 'a ticket beside a verified fix cleared too');
      } catch (error) {
        this.#o.log.warn({ workItem, other, err: error }, 'could not look again at a ticket beside a verified fix');
      } finally {
        this.#beside.delete(other);
      }
    }
  }

  /** Appends a look again, and lets the work item move on from it. */
  async #rechecked(workItem: string, payload: PayloadOf<'signal.rechecked'>): Promise<void> {
    await this.#append(workItem, [
      {
        type: 'signal.rechecked',
        actor: payload.sense && payload.sense !== 'report' ? payload.sense : 'factory',
        summary: recheckedLine(payload),
        payload,
      },
    ]);
    this.#lookAgainAt.delete(workItem);
    await this.#queue.moved(workItem);
    this.#o.log.info(
      { workItem, for: payload.for, outcome: payload.outcome, version: payload.version },
      'looked again at a signal',
    );
  }

  /** The work items a release carried, as its start recorded them, but this one, oldest first. */
  async #carriedBy(release: string, workItem: string): Promise<string[]> {
    const rows = await this.#o.sql<{ work_item: string }[]>`
      select distinct work_item, work_item::bigint as number from events
      where type = 'release.started' and payload->>'release' = ${release} and work_item is not null
        and work_item <> ${workItem}
      order by number limit 20`;
    return rows.map((row) => row.work_item);
  }

  /**
   * What a look again at `promotion` credits: the work items, but this one, carried by every real release promoted
   * after the ticket's signal was last recorded, up to and with that one, oldest first, each with the pull request it
   * merged, and the version the signal was last seen on. Its own release, if it had one, carried its fix: not another's.
   */
  async #carriedSince(
    workItem: string,
    promotion: Promotion,
  ): Promise<Pick<PayloadOf<'signal.rechecked'>, 'carried' | 'since' | 'merged'>> {
    const { sql } = this.#o;
    const [seen] = await sql<{ seq: string; version: string }[]>`
      select seq, payload->>'version' as version from events
      where work_item = ${workItem} and type = 'signal.received' order by seq desc limit 1`;
    const rows = await sql<{ work_item: string; pull_request: number | null }[]>`
      with releases as (
        select distinct payload->>'release' as release from events
        where type = 'release.promoted' and (payload->>'dryRun')::boolean is not true
          and seq > ${seen?.seq ?? '0'} and seq <= ${promotion.seq}
      ), carried as (
        select distinct s.work_item from events s join releases r on s.payload->>'release' = r.release
        where s.type = 'release.started' and s.work_item is not null and s.work_item <> ${workItem}
      )
      select c.work_item, (
        select (m.payload->>'number')::int from events m
        where m.work_item = c.work_item and m.type = 'pull-request.merged' order by m.seq desc limit 1
      ) as pull_request
      from carried c order by c.work_item::bigint limit 20`;
    const merged = rows.flatMap((row) =>
      row.pull_request === null ? [] : [{ workItem: row.work_item, pullRequest: row.pull_request }],
    );
    return {
      carried: rows.map((row) => row.work_item),
      ...(seen ? { since: seen.version } : {}),
      ...(merged.length ? { merged } : {}),
    };
  }

  /** When the last of the work items a work item waited on closed, or undefined while one is open. */
  async #waitEnded(state: WorkItemState): Promise<number | undefined> {
    const closed = await this.#closedAt(state.waiting?.on ?? []);
    const times = Object.values(closed).map((c) => (c ? Date.parse(c.closedAt) : Number.NaN));
    return times.length && times.every((t) => !Number.isNaN(t)) ? Math.max(...times) : undefined;
  }

  /**
   * The pages pictured while the release that carried the fix ran as a canary beside the version before, with the
   * ticket's own marked, and, when `named`, each other work item's the release carried named (`pictures.ts`). A dry
   * run's release never ran, and has none.
   */
  async #pictures(
    workItem: string,
    promoted: PayloadOf<'release.promoted'>,
    first: FirstSignal | undefined,
    named: boolean,
  ) {
    const { pictures } = this.#o;
    if (!pictures || promoted.dryRun) return { pages: [], artifacts: [] };
    // The ticket's own page: where its sense last boxed its check, with the elements it boxed, and its route.
    const ownOf = async (signal: FirstSignal | undefined): Promise<Own> => {
      const look = signal && (await pictures.lookOf(signal.sense, signal.check, signal.route));
      return {
        route: signal?.route ?? '*',
        ...(look && { path: look.path, selectors: look.elements.map((e) => e.selector) }),
      };
    };
    try {
      const taken = await pictures.of(promoted.version, promoted.previous);
      if (!taken.length) return { pages: [], artifacts: [] };
      const others = named ? await this.#othersOwn(promoted.release, workItem, ownOf) : [];
      const shown = pagesFor(taken, await ownOf(first), others);
      if (first && !shown.pages.some((p) => p.intended)) {
        this.#o.log.info({ release: promoted.release, route: first.route }, 'no page pictured is the ticket’s own');
      }
      return shown;
    } catch (error) {
      this.#o.log.warn({ release: promoted.release, err: error }, 'the release’s pictures could not be read');
      return { pages: [], artifacts: [] };
    }
  }

  /**
   * The other work items a release carried, each with its own page, to name on the pages a verification compares.
   * Only a label: one that cannot be read leaves every page unnamed, and the ticket's own pages as they are.
   */
  async #othersOwn(release: string, workItem: string, ownOf: (signal: FirstSignal | undefined) => Promise<Own>) {
    try {
      return await Promise.all(
        (await this.#carriedBy(release, workItem)).map(async (other) => ({
          workItem: other,
          own: await ownOf(await this.#firstSignal(other)),
        })),
      );
    } catch (error) {
      this.#o.log.warn({ release, err: error }, 'the other work items the release carried could not be read');
      return [];
    }
  }

  /** The ticket's first signal: its sense, check, route and evidence, never a report's words. */
  async #firstSignal(workItem: string): Promise<FirstSignal | undefined> {
    const [row] = await this.#o.sql<
      { sense: SignalSource; check: string; route: string; symptom: SymptomClass | null; evidence: Evidence[] | null }[]
    >`
      select payload->>'sense' as sense, payload->>'check' as check, payload->>'route' as route,
             payload->>'symptom' as symptom, payload->'evidence' as evidence
      from events where work_item = ${workItem} and type = 'signal.received' order by seq limit 1`;
    return (
      row && {
        sense: row.sense,
        check: row.check,
        route: row.route,
        ...(row.symptom ? { symptom: row.symptom } : {}),
        evidence: row.evidence ?? [],
      }
    );
  }

  /** Runs one agent's step, and does what its handback says. `since` is the last event as the step starts. */
  async #step(
    item: QueueItem,
    agent: LineAgent,
    round: number,
    state: WorkItemState,
    since: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { workItem } = item;
    const definition = this.#o.agents[agent];
    // Where its calls go as it starts, which a later pass's settings do not change.
    const provider = this.#providerOf(agent);
    const bounds = boundsOn(definition, provider);
    try {
      // A cap set after this, while the step runs, ends it without a result: that is the cap's, not the step's.
      const from = await lastSeq(this.#o.sql);
      const attempt = await this.#queue.startStep(workItem);
      // Before a pull request, a step starts from main; after, from the pull request's head, and its diff is taken
      // against the pull request's base. A step that reads the change measures it from where the pull request's
      // branch left its base, as GitHub's diff does: main may have moved on since. A step that plans the change
      // starts from there, which the change's tests are judged against, and is told of the work so far.
      const { github, repo } = this.#o;
      const number = state.pullRequest?.number;
      const pr = number ? await github.read('pullRequest', repo, { number }) : undefined;
      const head = pr ? pr.head.sha : await github.read('head', repo, { branch: 'main' });
      const reads = pr && definition.readsChange;
      const plans = pr && definition.plansFromBase;
      const compared = reads || plans ? await github.read('comparison', repo, { base: pr.base.ref, head }) : undefined;
      const commit = plans && compared ? compared.mergeBase : head;
      const base = compared ? compared.mergeBase : (pr?.base.sha ?? commit);
      const change =
        plans && compared ? { pullRequest: pr.number, files: compared.files.map((f) => f.path) } : undefined;
      // A pull request's head is checked out as GitHub has it; a dry run's, which GitHub never had, as the real
      // commit under it with the dry run's commits made on it in the runner.
      const checkout = pr ? await github.read('checkout', repo, { sha: commit }) : { commit, commits: [] };
      let started: Awaited<ReturnType<typeof definition.start>>;
      try {
        started = await definition.start({ ...this.#context(item, round, state, commit, base), change });
      } catch (error) {
        if (!(error instanceof StepFailed)) throw error;
        return await this.#failed(workItem, agent, null, [], error.message);
      }
      const outcome = await this.#o.steps.run({
        ...stepFrom(
          { ...definition, maxTurns: bounds.maxTurns },
          {
            repository: repo,
            commit: checkout.commit,
            commits: checkout.commits,
            base: reads ? base : undefined,
            prompt: started.prompt,
            resume: started.resume,
          },
        ),
        workItem,
        round,
        attempt,
        deadlineSeconds: bounds.deadlineSeconds,
        signal,
      });
      trace.getActiveSpan()?.setAttributes({
        [A.job]: outcome.job,
        [A.outcome]: outcome.kind === 'handed-back' ? outcome.handback.ending : outcome.kind,
      });
      if (outcome.kind === 'stopped') {
        countStep(agent, provider, 'stopped');
        this.#o.log.info({ workItem, agent, job: outcome.job }, 'a step stopped with the line; it runs again on start');
        return;
      }
      const effort = await this.#o.settings?.effortOf(outcome.job, agent);
      const calls = await stepCalls(this.#o.sql, outcome.job, agent, bounds.maxTurns, effort);
      const called: Draft[] = calls
        ? [{ type: 'model.called', actor: agent, summary: calledLine(agent, calls), payload: calls }]
        : [];
      const unfinished =
        outcome.kind === 'failed' || outcome.handback.ending !== 'finished' || outcome.handback.error !== undefined;
      const cap = unfinished && capOn(await capsInForce(this.#o.sql, from), provider);
      if (cap) {
        await this.#append(workItem, called);
        countStep(agent, providerOfStep(called) ?? provider, 'capped');
        this.#o.log.info(
          { workItem, agent, job: outcome.job, cap: cap.reason },
          'a step ended at a cap; it runs again when the cap clears',
        );
        return;
      }
      if (outcome.kind === 'failed') return await this.#failed(workItem, agent, outcome.job, called, outcome.reason);
      const { handback } = outcome;
      // A result written before the agent ran out of turns, or failed, is not one to act on.
      if (handback.ending !== 'finished') {
        const ended = handback.ending === 'max-turns' ? 'ran out of turns' : 'failed';
        const why = handback.error ? `: ${handback.error}` : '';
        return await this.#failed(workItem, agent, outcome.job, called, `The ${agent} ${ended}${why}`, handback.ending);
      }
      const pending: Pending = {
        agent,
        round,
        job: outcome.job,
        since,
        commit,
        base,
        handback,
        called,
        begun: [],
        done: {},
        tries: 0,
        failure: null,
        retryAt: null,
      };
      await this.#queue.keep(workItem, pending);
      await this.#effects(item, state, pending);
    } catch (error) {
      countStep(agent, provider, 'errored');
      throw error;
    } finally {
      await this.#release(workItem);
    }
  }

  /**
   * Does what a kept handback says, in GitHub and as events. A `StepFailed` counts against the step, and a
   * `StepStale` runs it again uncounted; anything else (GitHub or the store failing) keeps the handback for another
   * try, without the agent.
   */
  async #effects(item: QueueItem, state: WorkItemState, pending: Pending): Promise<void> {
    const { workItem } = item;
    const { agent } = pending;
    const provider = providerOfStep(pending.called) ?? this.#providerOf(agent);
    // The lease outlasts the writes, however long the agent took.
    await this.#queue.claim(workItem, EFFECTS_LEASE_SECONDS);
    let drafts: Draft[];
    try {
      const context = this.#effectsContext(item, state, pending);
      const started = await this.#o.agents[agent].start(context);
      drafts = await started.finish(pending.handback, context);
    } catch (error) {
      if (error instanceof StepFailed)
        return await this.#failed(workItem, agent, pending.job, pending.called, error.message);
      if (error instanceof StepStale) {
        await this.#append(workItem, pending.called);
        await this.#queue.drop(workItem);
        countStep(agent, provider, 'stale');
        this.#o.log.info({ workItem, agent, job: pending.job, reason: error.message }, 'a step is out of date: again');
        return;
      }
      const reason = messageOf(error);
      const tries = pending.tries + 1;
      if (tries >= LIMITS.effects) {
        const hold = holdDraft('factory', {
          stage: STAGE_OF[agent],
          kind: 'held',
          cause: 'failures',
          reason: cutTo(`The ${agent}'s work could not be put in GitHub ${tries} times: ${reason}`, 300),
        });
        await this.#append(workItem, [...pending.called, hold]);
        await this.#queue.moved(workItem);
        countStep(agent, provider, 'effects-failed');
        this.#o.log.warn({ workItem, agent, job: pending.job, reason }, 'a step’s effects kept failing: held');
        return;
      }
      const retryAt = new Date(this.#o.now().getTime() + retryAfterMs(tries));
      await this.#queue.effectsFailed(workItem, reason, retryAt);
      this.#o.log.warn({ workItem, agent, job: pending.job, reason, tries }, 'a step’s effects failed: trying again');
      return;
    }
    await this.#append(workItem, [...pending.called, ...drafts]);
    await this.#queue.moved(workItem);
    countStep(agent, provider, 'done');
    this.#o.log.info({ workItem, agent, job: pending.job, events: drafts.map((d) => d.type) }, 'a step is done');
  }

  /** An agent's turns and deadline, on the model its calls go to. */
  #bounds(agent: LineAgent): Bounds {
    return boundsOn(this.#o.agents[agent], this.#providerOf(agent));
  }

  /**
   * What the line is carrying, as this pass read Martin's controls and the settings in force: the one work item it acts
   * on, if only one, whether agents take new work, and each stage's limit, longer where its agents run on the local model.
   */
  #carrying(): Carrying {
    return {
      only: this.#only,
      newWork: this.#newWork,
      limits: limitsFor((agent) => this.#providerOf(agent), LOCAL_MODEL_PACE.deadline),
    };
  }

  /** Where an agent's calls go under the settings in force. */
  #providerOf(agent: LineAgent): Provider {
    return (this.#inForce?.providerOf ?? this.#o.providerOf)(agent);
  }

  /**
   * A failed attempt at a step: its calls are recorded, and it counts towards holding the work item. `counted` says
   * how it failed, for the line's count of steps: out of turns (`max-turns`), or any other way.
   */
  async #failed(
    workItem: string,
    agent: LineAgent,
    job: string | null,
    called: Draft[],
    reason: string,
    counted: Extract<StepEnding, 'failed' | 'max-turns'> = 'failed',
  ) {
    // However its agent ended, a step that counts as failed is one on its span.
    trace.getActiveSpan()?.setAttribute(A.outcome, 'failed');
    await this.#append(workItem, called);
    await this.#queue.failed(workItem, reason);
    countStep(agent, providerOfStep(called) ?? this.#providerOf(agent), counted);
    this.#o.log.warn({ workItem, agent, job, reason }, 'a step failed');
  }

  #context(item: QueueItem, round: number, state: WorkItemState, commit: string, base: string): StepContext {
    const { workItem } = item;
    return {
      workItem,
      issue: item.issue,
      round,
      state,
      commit,
      base,
      session: item.session,
      failure: item.failure,
      ticket: () => this.#publicTicket(workItem, state),
      request: () => this.#publicRequest(workItem),
      signals: () => this.#signals(workItem),
      flagsTaken: () => flagsTaken(this.#o.sql, workItem),
      read: (read, args) => this.#o.github.read(read, this.#o.repo, args),
    };
  }

  #effectsContext(item: QueueItem, state: WorkItemState, pending: Pending): EffectsContext {
    const { workItem } = item;
    const { github, repo } = this.#o;
    return {
      ...this.#context(item, pending.round, state, pending.commit, pending.base),
      once: async <T>(name: string, write: (again: boolean) => Promise<T>): Promise<T> => {
        // What a write gave back is kept as JSON, and given back as it was kept.
        if (Object.hasOwn(pending.done, name)) return pending.done[name] as T;
        const again = pending.begun.includes(name);
        if (!again) {
          await this.#queue.begun(workItem, name);
          pending.begun.push(name);
        }
        const result = await write(again);
        const kept = (result ?? null) as JSONValue;
        await this.#queue.done(workItem, name, kept);
        pending.done[name] = kept;
        return result;
      },
      act: (action, args) => github.act(action, repo, args, { workItem, agent: pending.agent }),
      // Its id is the same each time, and the inbox keeps the first: leaving it again does nothing.
      leaveSignal: async (key, signal) => {
        const observedAt = this.#o.now().toISOString();
        await sendSignal(this.#o.sql, { ...signal, observedAt }, signalId(workItem, key));
      },
      keepSession: (session) => this.#queue.setSession(workItem, session),
      log: this.#o.log,
    };
  }

  /** Opens the ticket's issue in the app's repository, from the ticket's public view. */
  async #openIssue(workItem: string, state: WorkItemState): Promise<number> {
    const ticket = await this.#publicTicket(workItem, state);
    const where =
      'class' in ticket.fingerprint
        ? `\`${ticket.fingerprint.class}\` on \`${ticket.fingerprint.route}\``
        : `the words “${ticket.fingerprint.text}” on \`${ticket.fingerprint.page}\``;
    const body = [
      `The factory’s ticket #${workItem}: ${where}.`,
      '',
      `- Category: ${ticket.category}`,
      `- Severity: ${ticket.severity}`,
      ...(ticket.traces.length ? [`- Traces: ${ticket.traces.map((t) => `\`${t}\``).join(', ')}`] : []),
      '',
      'The factory is working on it: its fix will come as a pull request that refers here. The issue closes when the fix is verified in production.',
    ].join('\n');
    return this.#o.github.act('openIssue', this.#o.repo, { title: ticket.title, body }, { workItem });
  }

  /**
   * Opens an improvement's issue in the app's repository, from the public views of its opening and Martin's request:
   * the title, and his words as anyone may read them.
   */
  async #openImprovementIssue(workItem: string): Promise<number> {
    const request = await this.#publicRequest(workItem);
    const quoted = request.words
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n');
    const body = [
      `The factory’s improvement #${workItem}. Martin asked for this improvement:`,
      '',
      quoted,
      '',
      'The factory is planning it: Martin approves its spec before any code is written, and its change comes as a pull request that refers here, behind a feature flag that stays off until he turns it on.',
    ].join('\n');
    return this.#o.github.act('openIssue', this.#o.repo, { title: request.title, body }, { workItem });
  }

  /**
   * Reads the pull request of every work item nobody is acting on, and appends what its gates and merge say that it
   * has not recorded. One with a step in hand, or a handback whose effects are not done, is left until they are: a
   * coder may have pushed its commit and not yet recorded the push, and gates read on that commit first would be
   * judged against the push before it. The lease alone does not say so: it may run out while GitHub is slow.
   */
  async #readGates(): Promise<void> {
    const { github, repo, log } = this.#o;
    let required: string[] | undefined;
    for (const item of await this.#queue.free()) {
      if (this.#inFlight.has(item.workItem) || item.effects || this.#dryRunLeft.has(item.workItem)) continue;
      try {
        const { raw } = await this.#raw(item.workItem);
        const state = fold(raw as LineEvent[]);
        // Once merged, the pull request has nothing more to say: the release carries the work item on.
        if (!state.pullRequest || state.merged) continue;
        const pr = await github.read('pullRequest', repo, { number: state.pullRequest.number });
        // A merged pull request's checks too, on its head, once GitHub names the merge commit: what they did since the
        // last read is recorded with the merge, which waits for that commit.
        const runs =
          pr.state === 'open' || pr.mergeCommit ? await github.read('checkRuns', repo, { sha: pr.head.sha }) : [];
        required ??= await github.read('requiredChecks', repo, { branch: 'main' });
        // A clearance that stands on the hold makes a close unmerged a verified one, and its issue closes completed.
        const cleared = state.hold ? state.cleared : undefined;
        // The line closes the pull request of a hold of its own itself: one closed under such a hold was its close,
        // caught here after a crash; any other is Martin's.
        const drafts = gateEvents(
          pr,
          runs,
          required,
          gateRecord(raw),
          cleared && {
            look: cleared,
            by: closesWhenCleared(state) ? 'factory' : 'martin',
          },
        );
        const verified = drafts.some((d) => d.type === 'work-item.closed' && d.payload.outcome === 'verified');
        if (cleared && verified && item.issue) {
          await closeIssue(
            github,
            repo,
            {
              number: item.issue,
              reason: 'completed',
              comment: closingComment(undefined, item.workItem, undefined, cleared),
            },
            item.workItem,
            log,
          );
        }
        if (drafts.length) await this.#append(item.workItem, drafts);
      } catch (error) {
        log.warn({ workItem: item.workItem, err: error }, 'could not read a pull request’s gates');
      }
    }
  }

  /**
   * The app's deploy pull request, once a minute: tells it what it carries, unless the line acts on one work item only,
   * and records where it stands for each held work item it carries (`deploy.ts`), that one's included. What it carries
   * is read once for both; a failure of one leaves the other to go on.
   */
  async #deploy(): Promise<void> {
    const { github, repo, log } = this.#o;
    const target = DEPLOYS.find((t) => t.repo === repo);
    if (!target) return;
    const proposal = await github.read('deployProposal', repo, { branch: target.branch });
    // Without a commit to start from, or with one GitHub never had, there is no range to look in.
    // A failure to work out what it carries leaves the records of pull requests already known to be read.
    const carries = proposal
      ? await carried(this.#o, proposal.commit, proposal.pinned ?? undefined).catch((error: unknown) => {
          log.warn({ err: error }, 'could not work out what the deploy pull request carries');
          return undefined;
        })
      : undefined;
    if (this.#only === null && proposal && carries) {
      await this.#describeDeploy(proposal, carries).catch((error: unknown) =>
        log.warn({ err: error }, 'could not say what the deploy pull request carries'),
      );
    }
    const held: HeldForDeploy[] = [];
    for (const item of await this.#queue.free()) {
      if (item.stage !== 'held' || this.#inFlight.has(item.workItem) || this.#dryRunLeft.has(item.workItem)) continue;
      const { raw } = await this.#raw(item.workItem);
      const { hold } = fold(raw as LineEvent[]);
      if (hold?.cause === 'deploy') held.push({ workItem: item.workItem, recorded: latestDeploy(raw, hold) });
    }
    if (!held.length) return;
    await recordDeploys(
      { github, repo, log, append: (workItem, drafts) => this.#append(workItem, drafts) },
      proposal,
      new Set((carries ?? []).map((c) => c.workItem)),
      held,
    );
  }

  /**
   * Tells the app's open deploy pull request which work items it carries (`carried`): each whose latest fix merged
   * after the commit the app runs (the last promoted release's, else the one pinned now), up to the one the pull
   * request runs. A dry run's merge commit, which GitHub never had, is in no range. The worker leaves a body that says
   * the same as it is; the line does not ask again until the list or the pull request changes.
   */
  async #describeDeploy(proposal: DeployProposal, carries: Carried[]): Promise<void> {
    const { github, repo, log } = this.#o;
    // The latest merges by name, and the rest counted.
    const named: Carry[] = carries
      .slice(-MAX_CARRIES)
      .map((c) => ({ ...c, title: c.title ?? `Work item ${c.workItem}` }));
    const more = carries.length - named.length;
    const deploy = { number: proposal.number, commit: proposal.commit, carries: named, ...(more ? { more } : {}) };
    const said = JSON.stringify(deploy);
    if (said === this.#described) return;
    let changed: boolean;
    try {
      // It names no work item: a deploy carries many.
      changed = await github.act('describeDeploy', repo, deploy);
    } catch (error) {
      // Merged or moved on since the watch last looked: its next pass says which pull request is open.
      if ((error as { status?: number }).status === 409) {
        log.debug({ number: proposal.number, commit: proposal.commit }, 'the deploy pull request moved on: later');
        return;
      }
      throw error;
    }
    this.#described = said;
    if (changed) {
      log.info(
        { number: proposal.number, commit: proposal.commit, carries: named.map((c) => c.workItem) },
        'said what the deploy pull request carries',
      );
    }
  }

  /** The ticket as its public view has it: what anyone may read, and so what may reach GitHub or an agent. */
  async #publicTicket(workItem: string, state: WorkItemState): Promise<PayloadOf<'ticket.opened'>> {
    const [row] = await this.#o.sql<{ public: { payload: PayloadOf<'ticket.opened'> } }[]>`
      select public from events where work_item = ${workItem} and type = 'ticket.opened' order by seq limit 1`;
    return row?.public.payload ?? need(state.ticket, 'a ticket');
  }

  /**
   * Martin's request for an improvement, as the public views of its opening and his request have it: what anyone may
   * read, and so what may reach GitHub or an agent. Only from his roles, as the queue took it.
   */
  async #publicRequest(workItem: string): Promise<Request> {
    const { sql } = this.#o;
    const [row] = await sql<{ title: string; words: string }[]>`
      select o.public->'payload'->>'title' as title, r.public->'payload'->>'words' as words
      from events r join events o on o.work_item = r.work_item and o.type = 'work-item.opened'
      where r.work_item = ${workItem} and r.type = 'improvement.requested' and ${byMartin(sql, 'r')}
        and o.payload->>'kind' = 'improvement' and ${byMartin(sql, 'o')}
      order by r.seq limit 1`;
    if (!row) throw new StepFailed('The work item has no request of Martin’s');
    return row;
  }

  /** What each sense saw, from their public views. A visitor's report is left out whole, not only its text. */
  async #signals(workItem: string): Promise<Signal[]> {
    const rows = await this.#o.sql<{ public: { payload: PayloadOf<'signal.received'> } }[]>`
      select public from events where work_item = ${workItem} and type = 'signal.received' order by seq`;
    return rows
      .map((row) => row.public.payload)
      .filter((payload) => payload.sense !== 'report' && !payload.report)
      .map(({ report: _report, ...signal }) => signal);
  }

  /**
   * A work item's events, upcast, and the last of them by its place in the store: Martin's answers only from his roles,
   * and the planner's specs only as the line recorded them (or from before the store recorded who appended each), so
   * no other worker can put a spec in front of Martin's approval, or the coder.
   */
  async #raw(workItem: string): Promise<{ raw: { type: string; payload: unknown }[]; last: number }> {
    const { sql } = this.#o;
    const rows = await sql<RawEvent[]>`
      select e.seq, e.type, e.version, e.payload from events e
      where e.work_item = ${workItem} and ${fromMartin(sql, 'e')}
        and (e.type <> 'spec.written' or e.appended_by is null or e.appended_by = ${LINE_ROLE})
      order by e.seq`;
    const raw = rows.flatMap((row) => {
      const read = upcast({ ...row, seq: Number(row.seq) });
      return read.ok ? [{ type: read.event.type, payload: read.event.payload }] : [];
    });
    return { raw, last: Number(rows.at(-1)?.seq ?? 0) };
  }

  /**
   * What the line knows of a work item beside its events: its row in the queue, its spend against the cap, and for a
   * held or waiting one, or one at the point after Plan where its spec is checked, what the rest of the line says.
   */
  async #facts(item: QueueItem, events: readonly LineEvent[]): Promise<Facts> {
    const facts: Facts = { ...item };
    const limitUsd = this.#inForce?.workItemLimitUsd ?? this.#o.workItemLimitUsd;
    if (limitUsd !== null) facts.spend = { spentUsd: await workItemSpend(this.#o.sql, item.workItem), limitUsd };
    const s = fold(events);
    if (s.closed) return facts;
    const waits = !s.hold && s.waiting !== undefined && !s.waiting.ended;
    // A ticket just taken, before its issue or the planner: not once a step has failed or handed back work.
    const taken = !s.spec && atTake(s) && item.failures === 0 && item.effects === null;
    if ((s.hold && !WORDS_LEAVE_HELD.includes(s.hold.cause)) || waits || taken) {
      this.#promotion ??= this.#latestPromotion().catch((error: unknown) => {
        // A read that failed is read again, not kept for the pass.
        this.#promotion = undefined;
        throw error;
      });
      const promotion = await this.#promotion;
      if (promotion && taken) {
        facts.stable = { release: promotion.release, version: promotion.version, due: true };
      } else if (promotion) {
        const [started] = await this.#o.sql<{ ts: Date }[]>`
          select ts from events where work_item = ${item.workItem} and type = ${s.hold ? 'hold.started' : 'wait.started'}
          order by seq desc limit 1`;
        const from = Math.max(promotion.at.getTime(), started ? new Date(started.ts).getTime() : 0);
        const due = this.#o.now().getTime() - from < this.#o.verifyWaitMs;
        facts.stable = { release: promotion.release, version: promotion.version, due };
      }
    }
    if (waits) facts.waitedOn = await this.#closedAt(s.waiting?.on ?? []);
    // Once, before the coder's first round: not after a coder's step has failed, or handed back work not yet done.
    const started = item.failures > 0 || item.effects !== null;
    const atCheck = !s.hold && !s.merged && s.spec && !s.waiting && !s.pullRequest && !s.rebuild && !started;
    if (atCheck && s.spec && this.#only === null) facts.overlaps = await this.#overlaps(item.workItem, s.spec.scope);
    return facts;
  }

  /** For each work item, when it last closed, or null while it is open, or reopened since. */
  async #closedAt(workItems: readonly string[]): Promise<Record<string, { closedAt: string } | null>> {
    const sql = this.#o.sql;
    const rows = await sql<{ work_item: string; type: string; ts: Date }[]>`
      select distinct on (work_item) work_item, type, ts from events
      where work_item = any(${workItems as string[]}) and type in ('work-item.closed', 'work-item.reopened')
      order by work_item, seq desc`;
    const closed: Record<string, { closedAt: string } | null> = Object.fromEntries(workItems.map((w) => [w, null]));
    for (const row of rows) {
      if (row.type === 'work-item.closed') closed[row.work_item] = { closedAt: new Date(row.ts).toISOString() };
    }
    // An improvement handed over to its flag stays open, for the flag pass, while its row on the line has ended: its
    // change is released, so a wait on it is over then. Not a reopened ticket's ended row, which comes back.
    const handedOver = await sql<{ work_item: string; moved_at: Date }[]>`
      select l.work_item, l.moved_at from line l
      where l.work_item = any(${workItems as string[]}) and l.stage = 'ended'
        and ${lastEnd(sql, 'l.work_item')} is distinct from 'work-item.reopened'
        and ${askedByMartin(sql, 'l.work_item')}`;
    for (const row of handedOver) closed[row.work_item] ??= { closedAt: new Date(row.moved_at).toISOString() };
    return closed;
  }

  /**
   * The work items in flight whose latest specs share files with this scope, each with the entries of it they share:
   * every other on the line that has not ended or closed and has a spec, in any pass, but those that wait on this one,
   * directly or through others.
   */
  async #overlaps(workItem: string, scope: readonly string[]): Promise<{ workItem: string; files: string[] }[]> {
    this.#flight ??= this.#readFlight();
    const flight = await this.#flight;
    const waitsOn = new Map(flight.map((f) => [f.workItem, f.waitsOn]));
    const reaches = (from: string, seen = new Set<string>()): boolean => {
      if (from === workItem) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (waitsOn.get(from) ?? []).some((next) => reaches(next, seen));
    };
    return flight.flatMap((other) => {
      if (other.workItem === workItem || !other.scope || reaches(other.workItem)) return [];
      const files = scopesOverlap(scope, other.scope);
      return files.length ? [{ workItem: other.workItem, files }] : [];
    });
  }

  async #readFlight(): Promise<InFlight[]> {
    const rows = (await this.#queue.all()).filter((row) => row.stage !== 'ended' && !row.waiting);
    const folded = await Promise.all(
      rows.map(async (row) => ({ workItem: row.workItem, s: fold((await this.#events(row.workItem)).events) })),
    );
    return folded.flatMap(({ workItem, s }) =>
      s.closed
        ? []
        : [{ workItem, scope: s.lastSpec?.scope, waitsOn: s.waiting && !s.waiting.ended ? s.waiting.on : [] }],
    );
  }

  /**
   * When Martin gave one of his answers to the work item's holds, by its place among them from 0, as the line reads
   * them: only from his roles.
   */
  async #answeredAt(workItem: string, answer: number): Promise<Date | undefined> {
    const { sql } = this.#o;
    const [row] = await sql<{ ts: Date }[]>`
      select e.ts from events e
      where e.work_item = ${workItem} and e.type = 'hold.answered' and ${fromMartin(sql, 'e')}
      order by e.seq offset ${answer} limit 1`;
    return row ? new Date(row.ts) : undefined;
  }

  async #events(workItem: string): Promise<{ events: LineEvent[]; last: number }> {
    const { raw, last } = await this.#raw(workItem);
    return { events: raw as LineEvent[], last };
  }

  async #append(workItem: string, drafts: Draft[]): Promise<void> {
    if (!drafts.length) return;
    const ts = this.#o.now().toISOString();
    await this.#o.events.append(drafts.map((draft) => asEvent(workItem, draft, ts)));
    countRecorded(drafts);
  }
}

/** How a work item a look again cleared closes, by when the sense looked, as its event's summary says it. */
const CLEARED_ON_LOOK: Record<PayloadOf<'signal.rechecked'>['for'], string> = {
  release: 'Verified on a release that did not carry its fix, and closed',
  wait: 'Verified on a release that did not carry its fix, and closed',
  take: 'Verified as the line took it, on a release since its signal, and closed',
  fix: 'Verified beside another work item’s fix, and closed',
};

/** The most open tickets the sense looks at again beside one verified fix. */
const BESIDE_A_FIX = 10;

/** A ticket the line has not taken, as closing it reads it: no row, so no issue, step or pull request. */
const untaken = (workItem: string): QueueItem => ({
  workItem,
  stage: 'plan',
  steps: 0,
  failures: 0,
  failure: null,
  issue: null,
  session: null,
  effects: null,
});

/** A real release's promotion, as a look reads it: the latest is what the stable Service runs. */
interface Promotion {
  release: string;
  version: string;
  previous: string;
  watched: boolean;
  at: Date;
  seq: string;
}

/** A work item in flight, as a spec after Plan is checked against it. */
interface InFlight {
  workItem: string;
  scope: string[] | undefined;
  waitsOn: string[];
}

/** The threads a review Martin accepted had answered, in a few words: "the threads of its 2 blocking findings are". */
function acceptedWords(findings: number, suggestions: number): string {
  const counted = (n: number, one: string, many: string) => (n === 1 ? `its ${one}` : `its ${n} ${many}`);
  const of = [
    findings ? counted(findings, 'blocking finding', 'blocking findings') : '',
    suggestions ? counted(suggestions, 'suggestion', 'suggestions') : '',
  ].filter(Boolean);
  const one = findings + suggestions === 1;
  return `the ${one ? 'thread' : 'threads'} of ${of.join(' and ')} ${one ? 'is' : 'are'}`;
}

/** Why a work item waits, in a line: "Waits for #1028, whose spec also changes src/example.ts". */
export function waitReason(on: readonly string[], files: readonly string[]): string {
  const who = workItemsWords(on, '').replace(/^work items? /, '');
  const what = files.length > 2 ? `${files.slice(0, 2).join(', ')} and ${files.length - 2} more` : files.join(' and ');
  return cutTo(`Waits for ${who}, whose spec${on.length > 1 ? 's also change' : ' also changes'} ${what}`, 300);
}

/**
 * What the line says on an improvement's issue as it hands it over: where its change is, and what is Martin's from
 * here. The flag is the spec's, which the planner names in every improvement's spec.
 */
export function handOverComment(workItem: string, flag: string | undefined, version: string): string {
  const behind = flag ? `behind its flag, \`${flag}\`` : 'behind its flag';
  return [
    `Released in ${version}, ${behind}, which is off: nobody sees the change yet.`,
    '',
    `Martin widens the flag a stage at a time from the factory’s console, and the factory checks each stage before the next. The factory’s improvement #${workItem} stays open while he does.`,
  ].join('\n');
}

/** A look again, in a line, as its event's summary says it. */
function recheckedLine(r: PayloadOf<'signal.rechecked'>): string {
  const on = r.version ? ` on ${r.version.slice(0, 7)}` : '';
  const by = r.sense ? `, by the ${r.sense}` : '';
  if (r.for === 'take') {
    if (r.outcome === 'cleared') return `Gone${on} as the line took it${by}`;
    if (r.outcome === 'persists') return `Still seen${on} as the line took it${by}: on to Plan`;
    return `As the line took it, the sense could not tell${on}: on to Plan`;
  }
  if (r.for === 'fix') {
    const fixes = r.carried.length ? ` beside the fix of ${workItemsWords(r.carried, '')}` : '';
    return r.outcome === 'cleared' ? `Cleared${on}${fixes}${by}` : `Still seen${on}${fixes}${by}`;
  }
  if (r.for === 'wait') {
    if (r.outcome === 'cleared') return `Its wait over, cleared${on}${by}`;
    if (r.outcome === 'persists') return `Its wait over, still seen${on}${by}: on to Build`;
    return `Its wait over, the sense could not tell${on}: on to Build`;
  }
  if (r.outcome === 'cleared') return `Cleared${on} on a release that did not carry its fix${by}`;
  if (r.outcome === 'persists') return `Still seen${on}${by}`;
  return `The sense could not tell${on}`;
}

/** The provider a step's calls went to, as its `model.called` says, if it made any. */
function providerOfStep(called: readonly Draft[]): 'anthropic' | 'bedrock' | 'local' | undefined {
  const calls = called.find((draft) => draft.type === 'model.called');
  return calls ? (calls.payload as PayloadOf<'model.called'>).provider : undefined;
}

/** The inbox id of a signal the line leaves for a work item: the same key always gives the same id. */
export const signalId = (workItem: string, key: string) => uuidFrom(`line:${workItem}:${key}`);

/** An error's own message, for an event: its causes are for the log, where they can name the cluster's addresses. */
const messageOf = (error: unknown) => (error as Error)?.message ?? String(error);

const calledLine = (agent: LineAgent, calls: PayloadOf<'model.called'>) =>
  `${agent[0]?.toUpperCase()}${agent.slice(1)} called ${calls.model} ${count(calls.calls, 'time')}`;
