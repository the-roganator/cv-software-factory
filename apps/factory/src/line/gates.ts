/**
 * The gates and Martin's merge, as events. GitHub never calls the factory, so the line reads each of its pull
 * requests through the GitHub worker, about once a minute, and appends what changed: the checks starting on a
 * commit (`gates.started`), each one finishing (`gate.finished`), all of them done (`gates.finished`), and the merge
 * (`pull-request.merged`), after whatever the gates on the pull request's head did since the last read. A pull request
 * closed without a merge closes its work item: as verified, when a look again found its signal cleared on a release
 * that did not carry it and nothing since says the defect is back (as when the line closed it for that reason, or
 * Martin did while it was held), and with no change otherwise.
 *
 * A check that failed is recorded with what it said was wrong (its annotations, which the worker reads with the
 * runs), so the coder is told why when the work comes back to it, not only which. A scan gate's run is recorded with
 * what it counted, by severity, on the base and on the change: from its own notice alone (`../gates/counts.ts`), on
 * GitHub Actions' run of it, which the worker reads for the head; a run with no notice that parses records none.
 *
 * `gateEvents` is the decision, a pure function of what GitHub says and what the work item has already recorded, so
 * reading the same state again appends nothing. The gates are done when every check the ruleset requires has
 * finished on the commit, and every other check that started there, or at a merge, on the checks that have finished;
 * they pass when every required one that finished passed. The factory's own check runs (the reviewer's) are not
 * gates, and are left out; nor is the review gate's (ADR 0014), which is Martin's say, not a gate a change can pass:
 * it waits for his approval, which comes after the gates.
 */
import {
  cutAt,
  cutTo,
  type EventType,
  GATE_ANNOTATION_CHARS,
  MAX_GATE_ANNOTATIONS,
  type NewEvent,
  type PayloadOf,
  recordedPath,
  VERSIONS,
} from '@software-factory/events';
import { ACTIONS_APP, countsOfCheck } from '../gates/counts.ts';
import { APP_LOGIN } from '../github/actions.ts';
import { type CheckRun, outcomeOf, type PullRequestState } from '../github/reads.ts';
import { whatClearedOnLook } from './verify.ts';

/** The App, as GitHub names the app behind a check run: the factory's own runs (the reviewer's) are not gates. */
export const APP_SLUG = 'mrogan-software-factory';

/**
 * The review gate's check (ADR 0014, scripts/review-gate.ts): Martin's say on a pull request, not one of its gates. The
 * review App posts it; a job of GitHub Actions' by that name would be a gate like any other.
 */
export const REVIEW_GATE_CHECK = 'review';

/** The checks the rulesets require that are gates: all but the review gate's. */
const gatesIn = (required: readonly string[]) => required.filter((name) => name !== REVIEW_GATE_CHECK);

/** What a work item has recorded about its pull request's gates and merge. */
export interface GateRecord {
  started: Set<string>;
  /** `commit check` for each check recorded as finished. */
  finished: Set<string>;
  done: Set<string>;
  merged: boolean;
  closed: boolean;
}

export function gateRecord(events: readonly { type: string; payload: unknown }[]): GateRecord {
  const record: GateRecord = {
    started: new Set(),
    finished: new Set(),
    done: new Set(),
    merged: false,
    closed: false,
  };
  for (const { type, payload } of events) {
    const p = payload as { commit?: string; check?: string };
    if (type === 'gates.started') record.started.add(p.commit ?? '');
    if (type === 'gate.finished') record.finished.add(`${p.commit} ${p.check}`);
    if (type === 'gates.finished') record.done.add(p.commit ?? '');
    if (type === 'pull-request.merged') record.merged = true;
    // Work sent back to Plan comes round again with a pull request of its own, which has not merged.
    if (type === 'work.returned' && (payload as { to?: string }).to === 'plan') record.merged = false;
    if (type === 'work-item.closed') record.closed = true;
    // So does a work item that reopened, with nothing of the pass that closed.
    if (type === 'work-item.reopened') Object.assign(record, { merged: false, closed: false });
  }
  return record;
}

const outcome: (conclusion: string | null) => PayloadOf<'gate.finished'>['conclusion'] = outcomeOf;

/**
 * What a failed run said was wrong, as `gate.finished` keeps it: its first annotations, each cut to fit, or nothing
 * when it named nothing. A run that did not fail says nothing here, whatever GitHub kept.
 */
function annotationsOf(run: CheckRun): PayloadOf<'gate.finished'>['annotations'] {
  if (outcome(run.conclusion) !== 'failure') return undefined;
  const kept = (run.annotations ?? [])
    .map(({ path, message }) => ({
      ...recordedPath(path.trim()),
      message: cutTo(message.trim(), GATE_ANNOTATION_CHARS),
    }))
    .filter(({ path, message }) => path && message)
    .slice(0, MAX_GATE_ANNOTATIONS);
  return kept.length ? kept : undefined;
}

/**
 * What a scan's run counted, as `gate.finished` keeps it: from the notices on GitHub Actions' run alone, whatever its
 * conclusion, and nothing from any other app's run of the scan's name or from a notice that does not parse.
 */
function findingsOf(run: CheckRun | undefined): PayloadOf<'gate.finished'>['findings'] {
  if (run?.app !== ACTIONS_APP || run.status !== 'completed' || !run.notices) return undefined;
  return countsOfCheck(run.name, run.notices);
}

/**
 * GitHub Actions' latest run of each check, by name: where a scan's counts come from, even when another app posted a
 * later run of the same name, which neither gives them nor hides Actions' own.
 */
function actionsRuns(runs: readonly CheckRun[]): Map<string, CheckRun> {
  const latest = new Map<string, CheckRun>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) if (run.app === ACTIONS_APP) latest.set(run.name, run);
  return latest;
}

const durationOf = (run: CheckRun) =>
  run.startedAt && run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)) : 0;

type Draft = {
  [K in EventType]: {
    type: K;
    actor: NewEvent['actor'];
    summary: string;
    payload: PayloadOf<K>;
    /** Pictures the probes worker took (`pictures/`): the line has no artifacts of its own. */
    artifacts?: NewEvent['artifacts'];
  };
}[EventType];

/**
 * The events a pull request's state calls for that the work item has not had yet, in order. `required` is the
 * checks the base branch's rulesets require, by name; `cleared` is the look again whose clearance stands on the work
 * item's hold, if one does, and who closes a pull request under that hold: the line, for a hold of its own.
 */
export function gateEvents(
  pr: PullRequestState,
  runs: readonly CheckRun[],
  required: readonly string[],
  record: GateRecord,
  cleared?: { look: PayloadOf<'signal.rechecked'>; by: 'factory' | 'martin' },
): Draft[] {
  if (record.merged || record.closed) return [];
  // GitHub can say a pull request merged before it names the merge commit: the next read records the merge.
  if (pr.merged && !pr.mergeCommit) return [];
  if (pr.merged && pr.mergeCommit) {
    // Through the merge queue, GitHub names as the merger whoever added the pull request to it, not the queue.
    const by = pr.mergedBy === APP_LOGIN ? 'factory' : 'martin';
    // What the gates on the pull request's head did since the last read comes first: a merge soon after they pass
    // would otherwise leave their round unfinished for good, since nothing reads the pull request after it.
    return [
      ...gateRun(pr, runs, required, record, true),
      {
        type: 'pull-request.merged',
        actor: by,
        summary: `${by === 'martin' ? 'Martin' : 'The factory'} merged PR #${pr.number}`,
        payload: { number: pr.number, commit: pr.mergeCommit, by },
      },
    ];
  }
  if (pr.state === 'closed' && cleared) {
    return [
      {
        type: 'work-item.closed',
        actor: cleared.by,
        summary: `PR #${pr.number} was closed unmerged, its signal cleared: verified`,
        payload: { outcome: 'verified', reason: cutTo(whatClearedOnLook(cleared.look), 200) },
      },
    ];
  }
  if (pr.state === 'closed') {
    return [
      {
        type: 'work-item.closed',
        actor: 'martin',
        summary: `PR #${pr.number} was closed without being merged`,
        payload: { outcome: 'no-change', reason: `Pull request #${pr.number} was closed without being merged` },
      },
    ];
  }

  return gateRun(pr, runs, required, record);
}

/**
 * The events the checks on the pull request's head call for that the work item has not had yet, in order. At a
 * merge, the round ends with it, judged on the checks that have finished: nothing reads the rest after it.
 */
function gateRun(
  pr: PullRequestState,
  runs: readonly CheckRun[],
  required: readonly string[],
  record: GateRecord,
  merged = false,
): Draft[] {
  required = gatesIn(required);
  const commit = pr.head.sha;
  const latest = latestRuns(runs);
  const actions = actionsRuns(runs);
  if (latest.size === 0) return [];
  const drafts: Draft[] = [];
  const pullRequest = pr.number;

  if (!record.started.has(commit)) {
    const checks = [...new Set([...required, ...latest.keys()])].map((name) => cutAt(name, 80)).slice(0, 40);
    drafts.push({
      type: 'gates.started',
      actor: 'actions',
      summary: `${checks.length} checks started on PR #${pullRequest}`,
      payload: { pullRequest, commit, checks },
    });
  }
  for (const run of latest.values()) {
    if (run.status !== 'completed' || record.finished.has(`${commit} ${cutAt(run.name, 80)}`)) continue;
    const conclusion = outcome(run.conclusion);
    const title = run.title?.trim();
    const summary = title === undefined ? undefined : cutTo(title, 200);
    const annotations = annotationsOf(run);
    const findings = findingsOf(actions.get(run.name));
    drafts.push({
      type: 'gate.finished',
      actor: 'actions',
      summary: `${cutAt(run.name, 80)} ${conclusion === 'success' ? 'passed' : conclusion === 'skipped' ? 'was skipped' : 'failed'}`,
      payload: {
        pullRequest,
        commit,
        check: cutAt(run.name, 80),
        conclusion,
        required: required.includes(run.name),
        durationMs: durationOf(run),
        ...(summary ? { summary } : {}),
        ...(annotations ? { annotations } : {}),
        ...(findings ? { findings } : {}),
      },
    });
  }

  const { waiting, judged, unfinished, failed, passed } = judge(latest, required, merged);
  if (!waiting && !record.done.has(commit)) {
    drafts.push({
      type: 'gates.finished',
      actor: 'actions',
      summary: failed.length
        ? `${failed[0]} failed on PR #${pullRequest}`
        : unfinished.length
          ? `PR #${pullRequest} merged before ${cutAt(unfinished[0] ?? '', 80)} finished`
          : `All ${judged.length} required checks passed on PR #${pullRequest}`,
      payload: {
        pullRequest,
        commit,
        conclusion: failed.length ? 'failed' : 'passed',
        passed,
        failed: failed.slice(0, 40),
      },
    });
  }
  return drafts;
}

/**
 * The latest run of each check on a commit, by name: a check run again replaces the run before. The factory's own are
 * left out, and so is the review gate's.
 */
export function latestRuns(runs: readonly CheckRun[]): Map<string, CheckRun> {
  const latest = new Map<string, CheckRun>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    const reviewGate = run.name === REVIEW_GATE_CHECK && run.app !== 'github-actions';
    if (run.app !== APP_SLUG && !reviewGate) latest.set(run.name, run);
  }
  return latest;
}

/**
 * How the checks on a commit stand, by their latest runs: still running while a required check, or any that started,
 * has not finished; then judged on the required ones that finished (every one, when none is required), where each that
 * failed fails the round, and one skipped does not. `passed` counts every finished check that succeeded. At a merge
 * nothing waits (`merged`), and a required check that never finished is `unfinished`.
 */
export function judge(latest: ReadonlyMap<string, CheckRun>, everyRequired: readonly string[], merged = false) {
  const required = gatesIn(everyRequired);
  const all = [...latest.values()];
  const finished = all.filter((run) => run.status === 'completed');
  // At a merge nothing waits: no read comes after it, so a round left open then would stay open for good.
  const waiting =
    !merged && (required.some((name) => latest.get(name)?.status !== 'completed') || finished.length < all.length);
  const judged = (required.length ? all.filter((run) => required.includes(run.name)) : all).filter((run) =>
    finished.includes(run),
  );
  const relevant = required.length ? required : all.map((run) => run.name);
  const unfinished = relevant.filter((name) => !judged.some((run) => run.name === name));
  const failed = judged.filter((run) => outcome(run.conclusion) === 'failure').map((run) => cutAt(run.name, 80));
  const passed = finished.filter((run) => outcome(run.conclusion) === 'success').length;
  return { waiting, judged, unfinished, failed, passed };
}

/** A draft as an event of the work item, or of the line (null), at its type's current version. */
export const asEvent = (workItem: string | null, draft: Draft, ts: string): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts,
    work_item: workItem,
    type: draft.type,
    version: VERSIONS[draft.type],
    actor: draft.actor,
    summary: draft.summary,
    payload: draft.payload,
    artifacts: draft.artifacts ?? [],
  }) as NewEvent;

export type { Draft };
