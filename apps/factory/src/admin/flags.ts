/**
 * Martin's stages of the feature flags, from the console's Flags panel: `POST /admin/flags/:flag/stage`, with the stage
 * the slider showed the flag at, the stage he chose, and his reason, which turning it off requires. The admin service
 * writes `flags`, the one FeatureFlag flagd watches, as its own service account, whose Role may get and update that
 * one object (deploy/base/flagd/admin-stages-flags.yaml), and whose every change an admission policy holds to the
 * stages' shapes (deploy/base/admission/flagd/flag-stages.yaml), rendered by `policy/flags.ts`.
 *
 * - **Judged from what is so.** The flag's stage is read from `flags`, never the request's word; a move from a stage
 *   other than the one the slider showed is refused, as a release control naming another release is; but for Off,
 *   which only ever tightens, so a kill switch is never blocked by a record that lags `flags` (a move made and never
 *   recorded): Off is taken from whatever stage `flags` holds, and that stage, not the slider's, is recorded as its
 *   `from`. What the move
 *   is (`flag.to-checks`, `flag.widen`, `flag.back-on`, `flag.narrow` or `flag.off`), and whether it can be taken now,
 *   is `policy/flag-moves.ts`'s, which the console draws each stop from too: the passkey again when that action needs
 *   it, a canary in flight read from the app's Rollout (`rollout.ts`), another flag at Share read from `flags`, and
 *   Martin's last move of the flag and Verify's comparison and check since, from the store. A move to where the flag is already
 *   records nothing.
 * - **The write.** `flags` is read, the one flag changed and every other flag kept at its stage, read back through
 *   `readFlags` and rendered again, so a flag in no stage's shape is never written back (it is dropped, which turns it
 *   off, and both the answer and the move's `flag.staged` name it), with a new `flag-set-revision`, and replaced whole, conditional on the
 *   `resourceVersion` it read. When `flags` changed in between, it is read again and the move judged again, up to
 *   three times, so two moves at once never lose one.
 * - **Recorded once made,** as a control of the canary is: `flag.staged` is checked before the write, and appended
 *   after it, in a transaction of its own, so a write Kubernetes refuses leaves no event (502), and no connection to
 *   the store waits on Kubernetes. A write whose answer never came is read back, and counts as made if `flags` holds
 *   the revision it wrote with the flag at its stage; as not made (502) if it does not; and, if it cannot be read back
 *   either, the answer says whether it was made can't be told (504), and nothing is recorded. An append that fails is tried once more, and if that fails too, the move stands in `flags`,
 *   is logged, and the answer says it was not recorded (500). Martin's last move then lags `flags`, and what depends
 *   on it (turning back on, Everyone) is refused until a move is recorded again.
 * - **Checked once written:** the app is asked soon whether it holds the new flag set (`flags-held.ts`), and a
 *   narrowing or Off it has not taken within a minute pages Martin.
 */
import type { NewEvent } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { flagEvents } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { ACCESS } from '../../../../policy/access.ts';
import {
  type Around,
  type FlagAction,
  type FlagNow,
  flagAction,
  flagsFrom,
  moveOf,
  sameStage,
  stageWords,
} from '../../../../policy/flag-moves.ts';
import { flagsSpec, isFlagName, REVISION_FLAG, readFlags, type Stage } from '../../../../policy/flags.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import { KubeError, type KubeWriter } from '../runners/kube.ts';
import type { FlagsHeld } from './flags-held.ts';
import type { ReleaseControls } from './rollout.ts';
import { adminEvent, appendMade, checked, Refused, type Session, steppedUpNow } from './store.ts';

/** A stage as the slider sends it: a share is checked against policy's, and refused if it is not one. */
const stage = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.enum(['off', 'checks', 'preview', 'everyone']) }),
  z.strictObject({ stage: z.literal('share'), share: z.number() }),
]);

/** A move, as the console sends it: the stage the slider showed (none: outside every stage), the one chosen, and why. */
export const MOVE = z.strictObject({
  from: stage.nullable(),
  to: stage,
  reason: PAYLOADS['line.stopped'].shape.reason.optional(),
});
export type Asked = z.infer<typeof MOVE>;

/** What a move did. */
export interface Staged {
  /** The move, or none when the flag was at that stage already. */
  staged: { flag: string; from: Stage | null; to: Stage; action: FlagAction; revision: string } | null;
  /** The flags `flags` held in no stage's shape, which the write dropped, and so turned off. */
  dropped?: string[];
}

/** `flags` as read: the whole object, written back with its flags replaced. */
const featureFlag = z.looseObject({
  metadata: z.looseObject({ resourceVersion: z.string() }),
  spec: z.looseObject({ flagSpec: z.looseObject({ flags: z.unknown().optional() }).optional() }),
});
type FeatureFlag = z.infer<typeof featureFlag>;

/** How many times a move reads `flags` again when it changed between the read and the write. */
const TRIES = 3;

/** The FeatureFlag's address in the Kubernetes API, as the stages write it and the check of the app reads it. */
export const featureFlagPath = (flags: RolloutRef): string =>
  `/apis/core.openfeature.dev/v1beta1/namespaces/${encodeURIComponent(flags.namespace)}` +
  `/featureflags/${encodeURIComponent(flags.name)}`;

/**
 * The next revision of the flag set: `r1`, `r2`, …, counting on from the one `flags` holds. With none it can read
 * (written by hand in another shape, or taken away), the count starts again from the time, in milliseconds, so no pod
 * still holding an old revision counts as holding the new set; `r1` only for a `flags` that holds no flag at all,
 * which no pod can hold an older set of than the empty one.
 */
export function nextRevision(held: string | undefined, now = Date.now(), empty = false): string {
  if (held === undefined && empty) return 'r1';
  if (held === undefined) return `r${now}`;
  const n = /^r(\d{1,15})$/.exec(held)?.[1];
  return n === undefined ? `r${now}` : `r${Number(n) + 1}`;
}

/** The summary of a move, in the console's words. */
export function stagedSummary(flag: string, action: FlagAction, from: Stage | null, to: Stage): string {
  switch (action) {
    case 'flag.to-checks':
    case 'flag.widen':
      return `Martin widened ${flag} from ${stageWords(from)} to ${stageWords(to)}`;
    case 'flag.back-on':
      return `Martin turned ${flag} back on for everyone`;
    case 'flag.narrow':
      return `Martin narrowed ${flag} from ${stageWords(from)} to ${stageWords(to)}`;
    case 'flag.off':
      return `Martin turned ${flag} off, from ${stageWords(from)}`;
  }
}

export class FlagStages {
  readonly #kube: KubeWriter;
  readonly #path: string;
  readonly #sql: Sql;
  readonly #log: Logger;
  readonly #releases: ReleaseControls | undefined;
  readonly #held: Pick<FlagsHeld, 'written'> | undefined;

  constructor(
    kube: KubeWriter,
    flags: RolloutRef,
    sql: Sql,
    log: Logger,
    releases?: ReleaseControls,
    held?: Pick<FlagsHeld, 'written'>,
  ) {
    this.#kube = kube;
    this.#path = featureFlagPath(flags);
    this.#sql = sql;
    this.#log = log;
    this.#releases = releases;
    this.#held = held;
  }

  /** Sets a flag's stage, and records it; or refuses, having changed nothing. */
  async stage(session: Session, flag: string, asked: Asked): Promise<Staged> {
    // As long as a name the events take: one longer is none an improvement's flag could be staged under.
    if (!isFlagName(flag) || flag.length > 100) throw new Refused('flag', 404, 'That is no flag of the app’s.');
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#once(session, flag, asked);
      } catch (error) {
        if (!(error instanceof KubeError) || error.status !== 409) throw error;
        if (attempt < TRIES) continue;
        throw new Refused('flags', 409, 'The flags kept changing as you pressed: look again.');
      }
    }
  }

  async #once(session: Session, flag: string, asked: Asked): Promise<Staged> {
    const read = await this.#kube.get(this.#path, featureFlag);
    if (!read) throw new Refused('flags', 503, 'There is no `flags` for the admin service to write.');
    const held = readFlags(read.spec);
    const stage: Stage | null = held.outside.includes(flag) ? null : (held.stages[flag] ?? { stage: 'off' });
    if (asked.to.stage !== 'off' && !sameStage(stage, asked.from as Stage | null)) {
      throw new Refused(
        'flag',
        409,
        `${flag} is at ${stageWords(stage)} now, not ${stageWords(asked.from as Stage | null)}: look again.`,
      );
    }
    const to = asked.to as Stage;
    const action = flagAction(stage, to);
    if (action === undefined) return { staged: null };
    if (action === 'flag.off' && !asked.reason) {
      throw new Refused('body', 400, 'Give a reason for turning it off, for the audit log and the work item.');
    }

    const intoShare = to.stage === 'share' && stage?.stage !== 'share';
    const [{ stagedOn, ...history }, around, steppedUp] = await Promise.all([
      this.#history(flag, stage),
      intoShare ? this.#around(flag, held.stages) : ({} as Around),
      steppedUpNow(this.#sql, session),
    ]);
    const now: FlagNow = { stage, ...history, ...(stagedOn && { stagedOn }) };
    const move = moveOf(flag, now, to, around);
    if (move.refused) throw new Refused('stage', 409, move.refused);
    if (ACCESS[action].stepUp && !steppedUp) throw new Refused('step-up', 403, 'This needs your passkey again.');

    const empty = Object.keys(held.stages).length === 0 && held.outside.length === 0;
    const revision = nextRevision(held.revision, Date.now(), empty);
    const rendered = flagsSpec({ ...held.stages, [flag]: to }, revision).flagSpec.flags;
    // Every name `flags` held in no stage's shape, the revision's aside: each is dropped, and so off.
    const dropped = held.outside.filter((name) => name !== flag && name !== REVISION_FLAG);
    // Checked before the write, so a move whose event the store would refuse changes nothing.
    // A flag once staged can always be turned off, on the work item it was staged on, though no spec names it now.
    const workItem = now.workItem ?? now.stagedOn;
    const event = checked(
      adminEvent(
        'flag.staged',
        stagedSummary(flag, action, stage, to) + (dropped.length ? `, and dropped ${dropped.length} set by hand` : ''),
        {
          flag,
          from: stage as PayloadOfStaged['from'],
          to: to as PayloadOfStaged['to'],
          action,
          revision,
          ...(asked.reason && { reason: asked.reason }),
          steppedUp,
          ...(dropped.length && { dropped }),
        },
        workItem,
      ),
    );
    await this.#write(read, rendered, revision, flag, to);
    // The app is asked soon whether it took it; a narrowing or Off, or a flag dropped and so turned off, that it has not
    // taken within a minute pages Martin.
    this.#held?.written(action === 'flag.narrow' || action === 'flag.off' || dropped.length > 0);
    if (dropped.length) this.#log.warn({ dropped }, 'dropped flags held in no stage’s shape, turning them off');
    await this.#record(event);
    this.#log.info({ flag, from: stage, to, revision }, `Martin's ${action} of a flag`);
    return { staged: { flag, from: stage, to, action, revision }, ...(dropped.length && { dropped }) };
  }

  /**
   * What the store says of a flag (`flagEvents`, which the line reads too): the improvement whose latest spec names it,
   * Martin's last move of it, and Verify's latest comparison and check since. A last move that is not the stage `flags`
   * holds (its event not recorded) says nothing of the flag as it stands, so neither it nor a judgement since counts.
   */
  async #history(flag: string, stage: Stage | null): Promise<Omit<FlagNow, 'stage'> & { stagedOn?: string }> {
    const { named, records } = await flagEvents(this.#sql, flag);
    const told = flagsFrom(records, named)[flag];
    const current = told?.last !== undefined && sameStage(told.last.to, stage);
    return {
      ...(told?.workItem && { workItem: told.workItem }),
      ...(told?.stagedOn && { stagedOn: told.stagedOn }),
      ...(current && { last: told.last }),
      ...(current && told.compared && { compared: told.compared }),
      ...(current && told.checked && { checked: told.checked }),
      // A baseline is the improvement's, whatever its moves since.
      ...(told?.baseline && { baseline: true }),
    };
  }

  /** What a move into Share waits for: another flag there, and a canary in flight, or not knowing. */
  async #around(flag: string, stages: Record<string, Stage>): Promise<Around> {
    const atShare = Object.entries(stages).find(([name, s]) => name !== flag && s.stage === 'share')?.[0];
    if (atShare) return { atShare };
    if (!this.#releases) return { canary: 'unknown' };
    try {
      const canary = await this.#releases.inFlight();
      return canary ? { canary } : {};
    } catch (error) {
      this.#log.warn({ err: error }, 'could not tell whether a canary is in flight');
      return { canary: 'unknown' };
    }
  }

  /**
   * Replaces `flags` with these flags, conditional on the object as it was read. A write whose answer never came, or
   * came as a server error, may have been made: `flags` is read again, and counts as made if it holds this revision,
   * with the flag at its stage.
   */
  async #write(
    read: FeatureFlag,
    flags: Record<string, unknown>,
    revision: string,
    flag: string,
    to: Stage,
  ): Promise<void> {
    const body = { ...read, spec: { ...read.spec, flagSpec: { ...read.spec.flagSpec, flags } } };
    try {
      await this.#kube.replace(this.#path, body);
    } catch (error) {
      if (error instanceof KubeError && error.kind !== 'server') {
        if (error.status === 409) throw error;
        throw new Refused('kubernetes', 502, 'Kubernetes refused the change, and nothing was done.');
      }
      // Made only if `flags` holds this revision with this flag at its stage: another move, of another flag, could
      // have written the same revision meanwhile.
      const now = await this.#kube.get(this.#path, featureFlag).catch(() => undefined);
      if (!now) {
        this.#log.error({ err: error }, 'wrote flags, and could neither hear the answer nor read them back');
        throw new Refused(
          'kubernetes',
          504,
          "Kubernetes didn't answer, and whether the change was made can't be told: look again before trying again.",
        );
      }
      const back = readFlags(now.spec);
      if (back.revision !== revision || !sameStage(back.stages[flag] ?? null, to)) {
        this.#log.error({ err: error }, 'wrote flags, and Kubernetes failed the write');
        throw new Refused('kubernetes', 502, 'Kubernetes failed the change, and nothing was done.');
      }
    }
  }

  async #record(event: NewEvent): Promise<void> {
    try {
      await appendMade(this.#sql, event);
    } catch (error) {
      this.#log.error({ err: error, event }, "set a flag's stage, and could not record it");
      throw new Refused('record', 500, 'Done, but not recorded: the store did not take the event. Look in the logs.');
    }
  }
}

type PayloadOfStaged = z.infer<(typeof PAYLOADS)['flag.staged']>;
