/**
 * Martin's controls of the app's release, from the console's Canary panel: the admin service reads the app's Rollout
 * and patches it, as its own service account, whose Role names that Rollout alone
 * (deploy/base/analysis/admin-controls-release.yaml), and whose every patch an admission policy holds to the fields
 * below (deploy/base/admission/website/rollout-controls.yaml). Each is the patch `kubectl argo rollouts` makes:
 *
 * - **Promote**, to the next step's weight: the status's step moved on to the next step that sets a weight short of
 *   100%, and its pauses cleared, wherever the canary is in the step it is at (setting its weight, pausing, or being
 *   analysed): the analysis of a step it leaves is stopped, as Argo Rollouts stops one for any step left behind.
 * - **Promote fully**: `status.promoteFull`, which sends the canary all of the traffic at once, skipping what is left.
 * - **Pause** and **Resume**: `spec.paused`. A paused canary keeps its weight until Martin resumes, promotes or aborts
 *   it; resuming gives it back to its own analysis, as it was, and promotes nothing. A promotion resumes a paused
 *   canary too, as `kubectl argo rollouts promote` does.
 * - **Abort**: `status.abort`, and the pause cleared if Martin had paused it, so none outlives its canary. The version
 *   before takes all of the traffic at once. Nothing failed, so it is no signal; the line records `release.aborted`
 *   with `by: martin`, from this control's event.
 * - **Retry**: `status.abort` cleared, and any pause left set cleared too, for a release that was stopped (by Martin, by
 *   stopping the line, or by an analysis error) or rolled back, which starts again from its first step, judged by its
 *   analysis afresh: with auto-rollback on, a canary judged bad rolls back again by itself. Not while the line is
 *   stopped, which starts no canary.
 *
 * **Paused for Martin** (auto-rollback off, the analysis judged the canary bad, `pauseConditions` naming
 * `InconclusiveAnalysisRun`): only Promote fully, past the analysis's verdict, and Abort, which the line records as a
 * rollback (`release/watch.ts`). Promote to the next step, Pause and Resume are refused: each would give the canary
 * past the verdict a step at a time, or leave it where it is.
 *
 * There is no rollback: that stays the analysis's, or Martin's abort of a canary it judged bad.
 *
 * **Stop the line** aborts whatever canary is in flight as the line stops (`line.ts`), named by nothing: the same abort,
 * recorded with a mark that it came with the stop, so the line records `release.aborted` with `by: stop` from it. A
 * release the line has not recorded yet has no version to record: it is aborted all the same, and the line tells who
 * aborted it by time, from the line's stop just before, as it tells `make stop-the-line`'s. A canary whose stable
 * version has no pod ready to serve is left alone, and the answer says so: aborting it would send every request to a version
 * that cannot serve one, as on the first release after the app is reset, whose stable version is one admission never
 * let run. Its pods are read from the app's EndpointSlices, which the admin service lists already to find the app's
 * pods (`flags-held.ts`), so it reads nothing more of the cluster for this: a pod of the stable version that is a
 * ready endpoint is one that can take the traffic back. A read that fails aborts nothing, as a read of the Rollout
 * failing does.
 *
 * The Rollout is read through the line's own schema and `observe` (`release/rollout.ts`), and the release in it named
 * as the line names it (`namedReleases`), from the line's records of every release of its pod hash, read with the
 * line's own queries (`release/recorded.ts`): a release the line recorded under another name than the Rollout's is the
 * one controlled.
 *
 * Each control names the release the panel showed Martin, and is refused if another is in flight now. The first patch
 * is conditional on the Rollout being as it was read (its `resourceVersion`), so a release that moved on in between is
 * read again, and the control decided again, rather than applied to what Martin did not see.
 * A resume that follows a status patch is conditional too, and tried again while the Rollout keeps changing; one that
 * still cannot be made leaves the control made, and its answer tells Martin his pause is still set.
 *
 * The control's event, `release.controlled`, is checked before the patch and appended once the first is made, before
 * any resume, in a transaction of its own, so a patch that fails leaves no event, no connection to the store waits on
 * Kubernetes, and the line finds the control as soon as the Rollout acts on it. A patch whose answer never came is
 * read back, and counts as made if the Rollout shows it, or shows the controller has acted on it (a promotion's
 * canary at or past its step, or all of the traffic). An append that fails is tried once more (`appendMade`), and if
 * that fails too, the control is logged as made without its event. The feature flags' stages are written and recorded
 * the same way (`flags.ts`).
 *
 * **A canary in flight** is also what a feature flag waits for before it may go to Share (`inFlight`): the two
 * versions would mix the flag's two sides.
 */
import type { NewEvent, ReleaseControl } from '@software-factory/events';
import { lineStopped } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  lastPromoted,
  type Recorded,
  recordedFrom,
  releaseName,
  releaseRecords,
  short,
  type TargetRecord,
} from '../release/recorded.ts';
import { namedReleases, observe, podHashes, rolloutSchema } from '../release/rollout.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import { KubeError, type KubeWriter } from '../runners/kube.ts';
import { adminEvent, appendMade, checked, Refused } from './store.ts';

/**
 * The Rollout, as the line reads it (`release/rollout.ts`), and what the controls read besides: what a conditional patch
 * needs, whether Martin paused it, and whether it is being promoted fully.
 */
const rolloutWithVersion = rolloutSchema.extend({
  metadata: rolloutSchema.shape.metadata.extend({ resourceVersion: z.string() }),
  spec: rolloutSchema.shape.spec.extend({ paused: z.boolean().optional() }),
  status: rolloutSchema.shape.status
    .unwrap()
    .extend({ promoteFull: z.boolean().optional() })
    .default({ conditions: [] }),
});
type Rollout = z.infer<typeof rolloutWithVersion>;

/** The Rollout's spec and status as they are, to see whether a patch whose answer never came was made. */
const rolloutRaw = z.object({
  spec: z.record(z.string(), z.unknown()),
  status: z.record(z.string(), z.unknown()).default({}),
});

/** What Stop the line reads of the app's EndpointSlices: each endpoint's pod, and whether it is ready. */
const ENDPOINT_SLICES = z.object({
  items: z.array(
    z.object({
      endpoints: z
        .array(
          z.object({
            conditions: z.object({ ready: z.boolean().nullish(), terminating: z.boolean().nullish() }).nullish(),
            targetRef: z.object({ kind: z.string().optional(), name: z.string().optional() }).nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

/** The release in the Rollout now, as the controls see it. */
export interface Canary {
  /**
   * Its name, as the line records it (`namedReleases`): the canary's pod-template hash and the Rollout's revision, or the
   * name the line recorded it under.
   */
  release: string;
  /** The Rollout's version, for a conditional patch. */
  resourceVersion: string;
  /** Whether a canary is out, beside the stable version, and not aborted. */
  inFlight: boolean;
  /** Whether it was aborted, by anyone or by an analysis, and not retried since. */
  aborted: boolean;
  /** Whether Martin has paused it (`spec.paused`). */
  paused: boolean;
  /** Whether it is being promoted fully already (`status.promoteFull`), by Martin or by `kubectl argo rollouts`. */
  promotingFully: boolean;
  /**
   * Whether the analysis judged it bad and Argo Rollouts paused it for Martin, with auto-rollback off: a run of it
   * ended Inconclusive (`InconclusiveAnalysisRun`).
   */
  judgedBad: boolean;
  /** The canary's share of the traffic now. */
  weight: number;
  /** The next step that sets a weight short of 100%, if there is one after the step it is at. */
  next: { index: number; weight: number } | undefined;
}

/**
 * What the controls see of a Rollout, given the line's records of the releases of its pod hashes and the release it
 * recorded promoted last: undefined while it has no release to act on, or its status has not caught up with its spec
 * (its revision may then be the next release's).
 */
export function canaryOf(rollout: Rollout, recorded: Recorded = new Map(), lastRelease?: string): Canary | undefined {
  const { metadata, spec, status } = rollout;
  const o = observe(rollout, []);
  const { current, revision } = o;
  if (!current || !revision) return undefined;
  const out = current !== o.stable;
  const aborted = o.aborted;
  const weight = status.canary?.weights?.canary.weight ?? 0;
  const steps = spec.strategy.canary?.steps ?? [];
  const at = o.stepIndex;
  const index = steps.findIndex(
    (step, i) => i > at && step.setWeight !== undefined && step.setWeight > weight && step.setWeight < 100,
  );
  const next = index === -1 ? undefined : { index, weight: steps[index]?.setWeight ?? 0 };
  return {
    release: namedReleases(o, recorded, lastRelease).current ?? releaseName(current, revision),
    resourceVersion: metadata.resourceVersion,
    inFlight: out && !aborted,
    aborted: out && aborted,
    paused: spec.paused === true,
    promotingFully: status.promoteFull === true,
    judgedBad: out && o.inconclusivePause,
    weight: aborted ? 0 : weight,
    next,
  };
}

/** The patches a control makes, the first of them conditional, and for a promotion the weight it goes to. */
export interface Plan {
  status?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  to?: number;
}

/** What a control does to the canary as it is, or why it cannot. */
export function planOf(action: ReleaseControl, canary: Canary): Plan | { refused: string } {
  const notInFlight = { refused: 'No canary is in flight: the release has ended, or was stopped.' };
  const promotingFully = { refused: 'The canary is being promoted fully already.' };
  // A promotion gives a paused canary back to Argo Rollouts too, as `kubectl argo rollouts promote` does.
  const resume = canary.paused ? { spec: { paused: false } } : {};
  const judgedBad = {
    refused:
      'The analysis judged the canary bad, and it waits for you: promote it fully past its verdict, or abort it.',
  };
  switch (action) {
    case 'pause':
      if (!canary.inFlight) return notInFlight;
      if (canary.judgedBad) return judgedBad;
      if (canary.paused) return { refused: 'The canary is paused already.' };
      return { spec: { paused: true } };
    case 'resume':
      if (!canary.inFlight) return notInFlight;
      if (canary.judgedBad) return judgedBad;
      if (!canary.paused) return { refused: 'The canary is not paused.' };
      return { spec: { paused: false } };
    case 'abort':
      if (!canary.inFlight) return notInFlight;
      // Aborted, a canary Martin paused is resumed too, so no pause outlives it into its retry or the next release.
      return { status: { abort: true }, ...resume };
    case 'promote':
      if (!canary.inFlight) return notInFlight;
      if (canary.promotingFully) return promotingFully;
      if (canary.judgedBad) return judgedBad;
      if (!canary.next) return { refused: 'The canary has no step before all of the traffic: promote it fully.' };
      return {
        status: { pauseConditions: null, controllerPause: false, currentStepIndex: canary.next.index },
        ...resume,
        to: canary.next.weight,
      };
    case 'promote-fully':
      if (!canary.inFlight) return notInFlight;
      if (canary.promotingFully) return promotingFully;
      return { status: { promoteFull: true }, ...resume, to: 100 };
    case 'retry':
      if (!canary.aborted) return { refused: 'Only a release that was stopped can be retried.' };
      return { status: { abort: false }, ...resume };
  }
}

/** How many times a control reads the Rollout again when it changed between the read and the patch. */
const TRIES = 3;

/** The refusal while the Rollout's status has not caught up with its spec: Stop the line waits it out. */
class BetweenReleases extends Refused {
  constructor() {
    super('release', 409, 'The Rollout is between releases: look again in a moment.');
  }
}

/**
 * How many times, a second apart, Stop the line looks for a pod of the stable version ready to serve before it leaves
 * the canary alone, so that a moment's readiness blip of the stable version's pods does not keep a canary from abort.
 */
const STABLE_LOOKS = 3;

/** How much of a pod's generated name is its ReplicaSet's, as Kubernetes cuts it: 63 characters less 5 random ones. */
const POD_NAME_BASE = 58;

/** The stable version had no pod ready to serve at that look: Stop the line looks again, up to `STABLE_LOOKS` times. */
class NoStablePod extends Error {}

/**
 * How long Stop the line waits for the Rollout's status to catch up with its spec, a second at a time: a release just
 * starting has its canary named in a moment, and is aborted then.
 */
const STOP_WAITS = 5;

export interface Controlled {
  action: ReleaseControl;
  release: string;
  weight: number;
  to?: number;
}

/** A control as the service answers it: the control made, and what it left undone, which its event does not carry. */
export interface Answered extends Controlled {
  warning?: string;
}

/** What a control that was made says when the pause Martin set could not be cleared after it. */
export const STILL_PAUSED =
  'Done, but your pause is still set: the Rollout kept changing. Resume the canary when the panel offers it, ' +
  'or the next release starts paused.';

/** The same, after a control that was made and could not be recorded either. */
const PAUSE_TOO = 'Your pause is still set too: resume the canary when the panel offers it.';

/**
 * What Stop the line did to the canary: there was none in flight, it aborted it, or it left it alone (`kept`), its stable
 * version having no pod ready to serve to take its traffic back.
 */
export type StopAbort =
  | { canary: 'none' }
  | { canary: 'kept'; release: string }
  | {
      canary: 'aborted';
      release: string;
      /** Whether its control was recorded: not for a release the line had not recorded yet, nor when the store failed. */
      recorded: boolean;
      warning?: string;
    };

/** The Rollout as the controls read it: the canary in it, and what the line has recorded of its releases. */
interface Read {
  canary: Canary;
  /** The line's record of the canary's release, if it has one, and it is not a dry run's. */
  record: TargetRecord | undefined;
  /** The stable version's pod-template hash (`status.stableRS`), if it has one. */
  stable: string | undefined;
  /** What naming the release in the Rollout again takes. */
  names: { recorded: Recorded; lastRelease: string | undefined };
}

export class ReleaseControls {
  readonly #kube: KubeWriter;
  readonly #path: string;
  readonly #rollout: RolloutRef;
  readonly #sql: Sql;
  readonly #log: Logger;

  constructor(kube: KubeWriter, rollout: RolloutRef, sql: Sql, log: Logger) {
    this.#kube = kube;
    this.#path =
      `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(rollout.namespace)}` +
      `/rollouts/${encodeURIComponent(rollout.name)}`;
    this.#rollout = rollout;
    this.#sql = sql;
    this.#log = log;
  }

  /** Makes a control of the release the panel showed, and records it; or refuses, having changed nothing. */
  control(action: ReleaseControl, release: string): Promise<Answered> {
    return this.#tried(() => this.#once(action, release));
  }

  /**
   * Stop the line's abort of whatever canary is in flight, recorded by the line or not, made once the line's stop is
   * recorded; nothing when none is in flight. Its control is recorded when the line has recorded the release, and a
   * failure to record it is logged and no more: the line tells the abort by time then, from the stop just before.
   */
  async stop(): Promise<StopAbort> {
    let looked = 0;
    for (let wait = 1; ; wait++) {
      try {
        return await this.#tried(() => this.#stopOnce(looked + 1 >= STABLE_LOOKS));
      } catch (error) {
        if (error instanceof NoStablePod) looked += 1;
        else if (!(error instanceof BetweenReleases) || wait > STOP_WAITS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  /** Does it, reading the Rollout again and deciding again when it changed between the read and the patch. */
  async #tried<T>(once: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once();
      } catch (error) {
        if (!(error instanceof KubeError) || error.status !== 409) throw error;
        if (attempt < TRIES) continue;
        throw new Refused('release', 409, 'The Rollout kept changing as you pressed: look again.');
      }
    }
  }

  /**
   * The Rollout, the canary in it, named as the line names it from its records of every release of the Rollout's pod
   * hashes, and the line's record of the canary's release.
   */
  async #read(): Promise<Read> {
    const rollout = await this.#kube.get(this.#path, rolloutWithVersion);
    if (!rollout) throw new Refused('rollout', 404, 'There is no Rollout of the app to control.');
    const observed = observe(rollout, []);
    const [rows, last] = await Promise.all([
      releaseRecords(this.#sql, podHashes(observed), true),
      lastPromoted(this.#sql),
    ]);
    const names = { recorded: recordedFrom(rows), lastRelease: last?.release };
    const canary = canaryOf(rollout, names.recorded, names.lastRelease);
    if (!canary) throw new BetweenReleases();
    const record = latestRecord([...(names.recorded.get(canary.release)?.values() ?? [])]);
    return { canary, record: record?.started.dryRun ? undefined : record, names, stable: observed.stable };
  }

  async #once(action: ReleaseControl, release: string): Promise<Answered> {
    const { canary, record, names } = await this.#read();
    if (canary.release !== release) {
      throw new Refused('release', 409, 'That release is no longer the one in the Rollout: look again.');
    }
    const plan = planOf(action, canary);
    if ('refused' in plan) throw new Refused('release', 409, plan.refused);
    if (!record) {
      throw new Refused('release', 409, 'The line has not recorded this release yet: look again in a moment.');
    }
    if (action === 'retry') {
      if (record.ended !== 'aborted' && record.ended !== 'errored' && record.ended !== 'rolled-back') {
        throw new Refused('release', 409, 'The line has not recorded how this release stopped yet: look again.');
      }
      if (await lineStopped(this.#sql)) {
        throw new Refused('line', 409, 'Start the line first: a stopped line starts no canary.');
      }
    }
    const controlled: Controlled = {
      action,
      release,
      weight: canary.weight,
      ...(plan.to !== undefined && { to: plan.to }),
    };
    // Stamped as the patch is made, and checked before it, so a control whose event the store would refuse changes
    // nothing.
    const event = checked(
      adminEvent('release.controlled', summaryOf(controlled, record.started.version), {
        ...controlled,
        version: record.started.version,
      }),
    );
    await this.#first(plan, canary);
    // Made: recorded at once, in a transaction of its own, so no connection waits on Kubernetes, and the line finds
    // Martin's control before it says who made what the Rollout did. Then the resume, if one follows, whatever the
    // record came to: Martin's pause outlives its canary otherwise.
    const recording = await this.#record(event).then(
      () => undefined,
      (error: unknown) => error,
    );
    const resumed = plan.status && plan.spec ? await this.#resume(plan.spec, canary, names) : true;
    if (recording instanceof Refused && !resumed) {
      throw new Refused(recording.refused, recording.status, `${recording.message} ${PAUSE_TOO}`);
    }
    if (recording) throw recording;
    this.#log.info({ action, release, weight: canary.weight, to: plan.to }, `Martin's ${action} of the canary`);
    return resumed ? controlled : { ...controlled, warning: STILL_PAUSED };
  }

  /** Stop the line's abort, once; with `last`, a canary whose stable version has no pod ready is left, not looked at again. */
  async #stopOnce(last: boolean): Promise<StopAbort> {
    const { canary, record, names, stable } = await this.#read();
    if (!canary.inFlight) return { canary: 'none' };
    if (!(await this.#available(stable))) {
      if (!last) throw new NoStablePod();
      this.#log.warn(
        { release: canary.release, stable },
        'Stop the line left the canary: its stable version has no pod',
      );
      return { canary: 'kept', release: canary.release };
    }
    const plan = planOf('abort', canary) as Plan;
    const event =
      record &&
      checked(
        adminEvent('release.controlled', stopSummary(canary.weight, record.started.version), {
          action: 'abort',
          release: canary.release,
          version: record.started.version,
          weight: canary.weight,
          stop: true,
        }),
      );
    await this.#first(plan, canary);
    const recorded = event
      ? await this.#record(event).then(
          () => true,
          () => false,
        )
      : false;
    const resumed = plan.spec ? await this.#resume(plan.spec, canary, names) : true;
    this.#log.info({ release: canary.release, weight: canary.weight, recorded }, 'Stop the line aborted the canary');
    return {
      canary: 'aborted',
      release: canary.release,
      recorded,
      ...(!resumed && { warning: STILL_PAUSED }),
    };
  }

  /**
   * Whether the stable version has a pod ready to serve: an endpoint of one of the app's Services that is ready, and not
   * shutting down, whose pod is the stable version's. Argo Rollouts names a version's ReplicaSet `<rollout>-<hash>`,
   * and Kubernetes names its pods from that, cut to 58 characters, so the pod's name says its version.
   * `scripts/abort-canaries.sh` reads the same, by the same rule.
   */
  async #available(stable: string | undefined): Promise<boolean> {
    if (!stable) return false;
    const { namespace, name } = this.#rollout;
    const slices = await this.#kube.get(
      `/apis/discovery.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/endpointslices`,
      ENDPOINT_SLICES,
    );
    const prefix = `${name}-${stable}-`.slice(0, POD_NAME_BASE);
    return (slices?.items ?? []).some((slice) =>
      (slice.endpoints ?? []).some(
        ({ conditions, targetRef }) =>
          // Kubernetes says to read a ready condition it does not know as ready; one shutting down is not.
          conditions?.ready !== false &&
          conditions?.terminating !== true &&
          (targetRef?.kind ?? 'Pod') === 'Pod' &&
          targetRef?.name?.startsWith(prefix) === true,
      ),
    );
  }

  /**
   * The plan's first patch, status first when it has one, conditional on the Rollout as it was read, so nothing is
   * applied to a release that moved on.
   *
   * A patch whose answer never came (the connection failed, or timed out), or came as a server error, may have been
   * made: the Rollout is read again, and counts as made if it shows the patch; as not made (502) if it does not; and,
   * when it can't be read back either, the answer says whether it was made can't be told (504).
   */
  async #first(plan: Plan, canary: Canary): Promise<void> {
    const precondition = { metadata: { resourceVersion: canary.resourceVersion } };
    const [path, part, set] = plan.status
      ? [`${this.#path}/status`, 'status' as const, plan.status]
      : [this.#path, 'spec' as const, plan.spec ?? {}];
    try {
      await this.#kube.patch(path, { ...precondition, [part]: set });
    } catch (error) {
      const answered = error instanceof KubeError && error.kind !== 'server';
      if (answered) throw kubeRefusal(error) ?? error;
      const shows = await this.#shows(set, part);
      if (shows === true) return;
      if (shows === undefined) {
        this.#log.error({ err: error }, 'patched the Rollout, and could neither hear the answer nor read it back');
        throw new Refused(
          'kubernetes',
          504,
          "Kubernetes didn't answer, and whether the change was made can't be told: look again before trying again.",
        );
      }
      this.#log.error({ err: error }, 'patched the Rollout, and Kubernetes failed the patch');
      throw new Refused('kubernetes', 502, 'Kubernetes failed the change, and nothing was done.');
    }
  }

  /**
   * A spec patch after a status patch (a promotion's or an abort's resume, a retry's): it reads the Rollout again, and
   * is made only while the same release is in it. When the Rollout changed in between, as the controller's writes to
   * its status often change it, it is read and tried again, up to `TRIES` times. Whether it was made is the answer: if
   * not, the control was made, and the canary stays paused until Martin resumes it.
   */
  async #resume(spec: Record<string, unknown>, canary: Canary, names: Read['names']): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        const now = await this.#kube.get(this.#path, rolloutWithVersion);
        const still = now && canaryOf(now, names.recorded, names.lastRelease);
        if (still?.release !== canary.release) {
          this.#log.error('made a control of the canary, and another release is in the Rollout now: it stays paused');
          return false;
        }
        await this.#kube.patch(this.#path, { metadata: { resourceVersion: still.resourceVersion }, spec });
        return true;
      } catch (error) {
        const conflict = error instanceof KubeError && error.status === 409;
        if (conflict && attempt < TRIES) continue;
        const unanswered = !(error instanceof KubeError) || error.kind === 'server';
        if (!conflict && unanswered && (await this.#shows(spec, 'spec')) === true) return true;
        this.#log.error({ err: error }, 'made a control of the canary, and could not resume it: it stays paused');
        return false;
      }
    }
  }

  /**
   * Whether the Rollout now shows a patch to its spec or its status: each field it sets, as it sets it. The controller
   * acts on a promotion at once, so one shows by where the canary is: at or past the step it moved to, whatever the
   * pauses there say now, or, promoted fully, already all of the traffic, which clears `promoteFull`. Undefined when
   * the Rollout can't be read: whether it shows the patch can't be told.
   */
  async #shows(set: Record<string, unknown>, part: 'spec' | 'status'): Promise<boolean | undefined> {
    const read = await this.#kube.get(this.#path, rolloutRaw).then(
      (rollout) => ({ rollout }),
      () => undefined,
    );
    if (!read) return undefined;
    const now = read.rollout;
    if (!now) return false;
    const { status } = now;
    if (part === 'status' && typeof set.currentStepIndex === 'number') {
      return typeof status.currentStepIndex === 'number' && status.currentStepIndex >= set.currentStepIndex;
    }
    if (part === 'status' && set.promoteFull === true && status.promoteFull !== true) {
      return typeof status.currentPodHash === 'string' && status.currentPodHash === status.stableRS;
    }
    return Object.entries(set).every(([field, value]) => shown(now[part][field], field) === value);
  }

  /**
   * The event of a control that was made, appended on its own; once more if that fails. Its id is the same each time,
   * so one that did commit after all is found, and recorded once.
   */
  async #record(event: NewEvent): Promise<void> {
    try {
      await appendMade(this.#sql, event);
    } catch (error) {
      this.#log.error({ err: error, event }, 'made a control of the canary, and could not record it');
      throw new Refused('record', 500, 'Done, but not recorded: the store did not take the event. Look in the logs.');
    }
  }

  /**
   * The canary in flight now, as a move of a feature flag into Share is judged (`flags.ts`): its version, as the line
   * recorded its release, or the release's name, and its weight; none when no canary is out. Throws when the Rollout
   * can't be read, isn't there, or is between releases: whether one is in flight can't be told.
   */
  async inFlight(): Promise<{ version: string; weight: number } | undefined> {
    const { canary, record } = await this.#read();
    if (!canary.inFlight) return undefined;
    return { version: record ? short(record.started.version) : canary.release, weight: canary.weight };
  }
}

/**
 * The record of a release, of the records on each target it carries. Each carries the same, but a work item closed
 * meanwhile has none of what came after: the record of the latest attempt, and of those one that has ended, is the
 * release's.
 */
export function latestRecord(records: readonly TargetRecord[]): TargetRecord | undefined {
  return records.reduce<TargetRecord | undefined>((best, record) => {
    if (!best) return record;
    if (record.attempts !== best.attempts) return record.attempts > best.attempts ? record : best;
    return best.ended === undefined && record.ended !== undefined ? record : best;
  }, undefined);
}

/**
 * The fields a plan sets that Argo Rollouts leaves out of the Rollout when they are false (`omitempty` on a Go bool:
 * `status.abort`, `status.controllerPause`, `status.promoteFull` and `spec.paused`), so one that is absent is false, as
 * the controller reads it. A Rollout written back from Go's types loses a false flag (a retry's `abort: false`), and
 * a control that was made would otherwise read back as not made.
 */
const FLAGS = new Set(['abort', 'controllerPause', 'promoteFull', 'paused']);

/** A field of the Rollout as a plan would set it: a flag that is absent is false, and anything else absent is null. */
function shown(value: unknown, field: string): unknown {
  return value ?? (FLAGS.has(field) ? false : null);
}

/** A refusal from Kubernetes, as the service says it: the policy or the Role refused the patch, and nothing changed. */
function kubeRefusal(error: unknown): Refused | undefined {
  if (!(error instanceof KubeError)) return undefined;
  if (error.status === 409) return undefined;
  if (error.kind === 'refused' || error.kind === 'invalid') {
    return new Refused('kubernetes', 502, 'Kubernetes refused the change, and nothing was done.');
  }
  return undefined;
}

/** The summary of Stop the line's abort, in the console's words. */
export const stopSummary = (weight: number, version: string) =>
  `Martin stopped the line, which aborted the canary of ${short(version)} at ${weight}%`;

/** The event's summary, in the console's words. */
export function summaryOf({ action, weight, to }: Controlled, version: string): string {
  const canary = `the canary of ${short(version)}`;
  switch (action) {
    case 'promote':
      return `Martin promoted ${canary} from ${weight}% to ${to}%`;
    case 'promote-fully':
      return `Martin promoted ${canary} fully, from ${weight}%`;
    case 'pause':
      return `Martin paused ${canary} at ${weight}%`;
    case 'resume':
      return `Martin gave ${canary} back to its analysis at ${weight}%`;
    case 'abort':
      return `Martin aborted ${canary} at ${weight}%`;
    case 'retry':
      return `Martin retried the release of ${short(version)}`;
  }
}
