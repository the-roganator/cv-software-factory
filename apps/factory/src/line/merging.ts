/**
 * Whether the line adds a change that passed its gates and review to the merge queue itself, or holds it for Martin's
 * merge, and why (spec 4.3, ADR 0014). A pure function of the work item's state and what GitHub says of its pull
 * request now (`MergeFacts`), which the line reads through the GitHub worker about once a minute while the change waits
 * (`worker.ts`), so a verdict judged again, a conflict or a push is heard by polling, as the gates are.
 *
 * The line adds it to the queue, at the head the review gate judged, only when every one of these holds:
 *
 * - the review App's own `review` check on the pull request's head concluded, with a verdict for that head (the GitHub
 *   worker reads it from that check alone, `github/merging.ts`): never the factory's reviewer's check, whose words a
 *   model wrote;
 * - that head is the one the line's own gates passed and its reviewer passed (`review.submitted` names the head it was
 *   given): the gate does not read the factory's reviewer, so `review` alone is never enough;
 * - the gate's rule is one the autonomy level lets the line merge by, with auto-merge on (`ENQUEUES`, `policy/line.ts`);
 * - it is not a change that is never the line's: an improvement, a release, a red-team branch, or a work item whose spec
 *   was ever tagged `out-of-scope`, whatever the rule;
 * - it does not conflict with main, the queue has not taken it out at that head, and GitHub has not refused to add it.
 *
 * Otherwise it is held for Martin (`hold.started`, cause `merge`), with the gate's rule, its tags and its words, and why
 * the line does not add it (`MERGE_HOLDS`), so Needs you can say so. A hold that would say the same is not made again.
 * Where Martin's approval of the head on GitHub would let the line add it (Guarded or Lights-out, auto-merge on, not a
 * change that is never the line's), the hold says so (`approving`): the gate then passes it as `martin-approved-head`,
 * and the line adds it. A push after his approval fails the gate again, and the line holds it again.
 *
 * Only a pull request the gate refused (rule `held`) is a refusal: it is recorded once for each head it held, as
 * `action.refused` with mechanism `review-gate`, signed by the GitHub worker and verified by the line, before the hold.
 * A change held only because the level or auto-merge does not let the line add it is Martin's ordinary merge, and no
 * refusal.
 *
 * While the review App's check on the head has not concluded, or there is none yet, the change waits at Review for the
 * gate, as for any gate: nothing is held for a verdict about to come.
 */
import type { Autonomy, GateRule, PayloadOf } from '@software-factory/events';
import { cutTo } from '@software-factory/events';
import { canonical } from '@software-factory/events/signed';
import { enqueues } from '../../../../policy/line.ts';
import type { Judged } from '../../../../policy/review-verdict.ts';
import { redTeamBranch } from '../github/branches.ts';
import type { Decision, WorkItemState } from './machine.ts';

/** What the line reads of a pull request ready to merge, and its controls in force, as it decides whether to queue it. */
export interface MergeFacts {
  /** Martin's autonomy level and auto-merge switch, as the line read them this pass. */
  autonomy: Autonomy;
  autoMerge: boolean;
  /** The pull request's head now. */
  head: string;
  /** The review App's latest `review` check on that head, or null while there is none. */
  check: { status: string; conclusion: string | null; title: string | null; url: string | null } | null;
  /** The gate's verdict on this pull request at that head, or null with why there is none (`problem`). */
  judged: Judged | null;
  problem: string | null;
  /**
   * The gate's refusal, when it held the pull request at this head: signed by the GitHub worker and verified by the
   * line, ready to append. None when it was not signed, or does not verify.
   */
  refusal?: PayloadOf<'action.refused'>;
  /** Whether it conflicts with its base; null while GitHub has not worked it out. */
  conflicts: boolean | null;
}

type Hold = PayloadOf<'hold.started'>;
type Merge = NonNullable<Hold['merge']>;

const LEVEL: Record<Autonomy, string> = { supervised: 'Supervised', guarded: 'Guarded', 'lights-out': 'Lights-out' };

const short = (sha: string) => sha.slice(0, 7);

/** Why a change is never the line's to add to the queue, whatever the gate said, or undefined when it may be. */
export function neverTheLines(s: WorkItemState, judged: Judged | null): string | undefined {
  if (s.request) return 'an improvement Martin asked for, which he merges in every mode';
  if (s.outOfScope) return 'its spec was tagged out-of-scope, which Martin merges in every mode';
  if (s.pullRequest && redTeamBranch(s.pullRequest.branch)) return 'a red-team branch, which is never merged';
  const tags = new Set(judged?.tags.map((t) => t.tag));
  if (tags.has('release')) return 'the gate found it a release, which Martin merges in every mode';
  if (tags.has('improvement')) return 'the gate found it an improvement, which Martin merges in every mode';
  return undefined;
}

/** The tags the gate found, in words. */
const tagWords = (judged: Judged) => judged.tags.map((t) => t.tag).join(', ');

/**
 * What the line does with a change ready to merge: add it to the queue, record the gate's refusal of its head, wait for
 * the gate, or hold it for Martin. `undefined` from a hold that says what the one in force says: nothing new.
 */
export function mergeDecision(s: WorkItemState, m: MergeFacts): Decision | undefined {
  const pr = s.pullRequest;
  if (!pr) return undefined;
  // In the queue at this head: the queue merges it, or takes it out, which the line reads as the gates are read.
  if (s.enqueued?.commit === m.head) return { stage: 'review', next: { do: 'wait', for: 'queue' } };
  // The gate's refusal of this head, once, before anything else is said of it.
  if (m.judged?.rule === 'held' && m.refusal && !s.refusedHeads.includes(m.head)) {
    return { stage: 'review', next: { do: 'refused', head: m.head, refusal: m.refusal } };
  }
  const hold = mergeHold(s, m);
  if (hold === 'pending') {
    // A hold in force stands while the gate judges again.
    return s.hold ? undefined : { stage: 'review', next: { do: 'wait', for: 'gates' } };
  }
  if (hold === undefined) {
    const rule = m.judged?.rule as GateRule;
    return { stage: 'review', next: { do: 'enqueue', number: pr.number, head: m.head, rule } };
  }
  if (s.hold?.cause === 'merge' && sameHold(s.hold, hold)) return undefined;
  return { stage: 'held', next: { do: 'hold', hold } };
}

/** Whether two holds say the same, as the store keeps them: its JSON keeps no order of keys. */
const sameHold = (a: Hold, b: Hold) => a.reason === b.reason && canonical(a.merge) === canonical(b.merge);

/** The hold for a change ready to merge, `pending` while the gate has not judged its head, or undefined to queue it. */
export function mergeHold(s: WorkItemState, m: MergeFacts): Hold | 'pending' | undefined {
  const pr = s.pullRequest;
  if (!pr) return 'pending';
  const number = pr.number;
  const { judged } = m;
  const never = neverTheLines(s, judged);
  const verdict: Pick<Merge, 'rule' | 'tags' | 'said' | 'check'> = {
    ...(judged ? { rule: judged.rule, tags: judged.tags } : {}),
    ...(m.check?.title ? { said: cutTo(m.check.title, 300) } : {}),
    ...(m.check?.url ? { check: m.check.url } : {}),
  };
  const held = (why: Merge['why'], reason: string, extra: Partial<Merge> = {}): Hold => ({
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: cutTo(reason, 300),
    merge: { pullRequest: number, head: m.head, why, ...verdict, approving: false, ...extra },
  });

  // What the queue or GitHub said of this head stands until the head moves: the line does not ask again.
  if (s.dequeued?.commit === m.head) {
    const { reason, failed } = s.dequeued;
    const checks = failed.length ? `: ${failed.join(', ')} failed on the queue’s commit` : '';
    return held('queue', `The merge queue took #${number} out (${reason})${checks}. It waits for Martin`, {
      queue: { reason, failed },
    });
  }
  if (s.hold?.cause === 'merge' && s.hold.merge?.why === 'refused' && s.hold.merge.head === m.head) return s.hold;
  if (m.conflicts === true) {
    return held(
      'conflict',
      `Pull request #${number} conflicts with main: it waits for Martin to put it right or merge it`,
    );
  }
  if (m.check?.status !== 'completed') return 'pending';
  if (!judged) {
    const why = m.problem ?? 'it carries none';
    return held(
      'no-verdict',
      `The review gate gave no verdict the line can trust on #${number} at ${short(m.head)}: ${why}. It waits for Martin`,
    );
  }
  if (s.review?.commit !== m.head || s.gates?.commit !== m.head || !s.gatesPassed) {
    return held(
      'unreviewed',
      `Pull request #${number} is at ${short(m.head)}, not the head its gates and the factory’s reviewer passed: it waits for Martin to merge it`,
    );
  }
  if (judged.rule === 'held') {
    const approving = !never && enqueues(m, 'martin-approved-head');
    const tags = judged.tags.length ? ` for ${tagWords(judged)}` : '';
    const then = approving
      ? 'Martin’s approval of its head on GitHub sends it to the merge queue'
      : `it waits for Martin to merge it${never ? `: ${never}` : ''}`;
    return held('held', `The review gate held #${number}${tags}: ${then}`, { approving });
  }
  if (never) {
    const reason = s.request
      ? `The improvement in pull request #${number} has passed its gates and review, and waits for Martin to merge it, as an improvement does in every mode`
      : `The change in pull request #${number} has passed its gates and review, and waits for Martin to merge it: ${never}`;
    return held('never', reason);
  }
  if (!enqueues({ autonomy: m.autonomy, autoMerge: true }, judged.rule)) {
    const reason =
      m.autonomy === 'supervised'
        ? `The review gate passed #${number} by ${judged.rule}, and at Supervised the line adds nothing to the merge queue: it waits for Martin to merge it`
        : `The review gate passed #${number} by ${judged.rule}, which the line does not merge by at ${LEVEL[m.autonomy]}: it waits for Martin to merge it`;
    return held('level', reason);
  }
  if (!m.autoMerge) {
    return held(
      'auto-merge',
      `The review gate passed #${number} by ${judged.rule}, and with auto-merge off it waits for Martin to merge it`,
    );
  }
  return undefined;
}
