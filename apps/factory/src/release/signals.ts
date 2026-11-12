/**
 * A rollback is a signal. When the canary's analysis fails a release, the line leaves triage a signal from the
 * `canary` sense for each measure that failed, and triage treats it as any sense's: a ticket, or evidence on the
 * ticket it repeats. Each stands for the symptom class its measure does:
 *
 * | Measure | Symptom class | Route |
 * |---|---|---|
 * | errors | `server-error` | the one route where the canary did worse, or `*` for more than one, or none found |
 * | latency | `slow-response` | as for errors |
 * | journeys | the first failing check's own | that check's, or `*` for checks on more than one; `*` when the Job's words are lost |
 *
 * The signal comes from an AnalysisRun whose phase is Failed, never from the Rollout's state: Martin's abort leaves
 * the Rollout as a failed analysis does, but it terminates the runs, which fails none, so an abort sends nothing. Too
 * few requests fails a step too, but says the traffic fell short, not that the canary did worse: it sends nothing.
 *
 * With auto-rollback off, the analysis judges a bad canary Inconclusive instead, and Argo Rollouts pauses it for
 * Martin. His abort of it is a rollback (`release.rolled-back` by `martin`, `watch.ts`), and sends what the analysis
 * judged bad as a failed measure would be sent: each measure that was inconclusive in the runs of the attempt he
 * aborted, with the analysis's words verbatim. An Inconclusive run of an attempt that was promoted, or stopped with
 * the line, sends nothing.
 *
 * A signal is named by the run and the measure, so the line can send it again after a restart and triage takes it
 * once, whatever it reads the second time: not by its route, which comes from reads (Prometheus, the Job's pod) that
 * could answer differently later. Only the runs of a release the line recorded starting, and watched, are read: an
 * older run still in the cluster, or a run of a release found live, was before the line watched. A retried release's
 * earlier attempts' failed runs are its own, each sent once: each failed the version the line watched.
 */
import { cutTo, type DefectSymptom, type InboxSignal, type PayloadOf } from '@software-factory/events';
import { uuidFrom } from '@software-factory/triage/events';
import type { Regression } from '../gates/journeys.ts';
import type { RoutesWorse } from './read.ts';
import { type AttemptEnd, type Recorded, short } from './recorded.ts';
import type { AnalysisRun, Observed } from './rollout.ts';
import { measuresOf, recordOf, type Series } from './watch.ts';

type Started = PayloadOf<'release.started'>;
type Measure = PayloadOf<'canary.stepped'>['analysis']['measures'][number];

/** The symptom class each measure stands for. A measure not named here sends no signal. */
const SYMPTOMS: Record<string, DefectSymptom | 'journey'> = {
  errors: 'server-error',
  latency: 'slow-response',
  journeys: 'journey',
};

/**
 * The class of a failed journey whose comparison could not be read, or whose check could not finish: a check that
 * passed on the baseline came out wrong on the canary.
 */
export const JOURNEY_FALLBACK: DefectSymptom = 'wrong-result';

/** One failed measure of one run, and the release it judged. */
export interface FailedMeasure {
  run: AnalysisRun;
  measure: Measure;
  started: Started;
}

/**
 * Every failed measure that sends a signal, in the runs of the releases the line recorded, oldest run first: each that
 * failed, and each the analysis judged bad in an attempt Martin rolled back.
 */
export function failedMeasures(o: Observed, recorded: Recorded): FailedMeasure[] {
  return o.runs.flatMap((run) => {
    const phase =
      run.status.phase === 'Failed' ? 'failed' : run.status.phase === 'Inconclusive' ? 'inconclusive' : null;
    if (!phase || run.spec.terminate) return [];
    const record = [...(recordOf(recorded, run)?.values() ?? [])][0];
    const started = record?.started;
    // A release found live was out before the line watched it: its runs, failed or not, are from before.
    if (!started?.watched) return [];
    if (phase === 'inconclusive' && !rolledBackByMartin(run, record?.ends ?? [])) return [];
    return measuresOf(run)
      .filter((measure) => measure.phase === phase && SYMPTOMS[measure.name] !== undefined)
      .map((measure) => ({ run, measure, started }));
  });
}

/**
 * Whether the attempt a run ended in was Martin's rollback: the first attempt that ended at or after the run did, and
 * that it was made in. Argo Rollouts keeps both times to the second, rounded down, so a run that ended before the abort
 * ended no later than its second. A retry comes after the abort, so a run made in the abort's second or after, once the
 * release started again, is the retry's, however soon it ended: it never takes the earlier attempt's end for its own.
 */
function rolledBackByMartin(run: AnalysisRun, ends: readonly AttemptEnd[]): boolean {
  const done = Date.parse(run.status.completedAt ?? '');
  const made = Date.parse(run.metadata.creationTimestamp);
  if (!Number.isFinite(done) || !Number.isFinite(made)) return false;
  const end = ends.find((e) => {
    const at = Date.parse(e.at);
    return at >= done && !(e.retried && made >= at);
  });
  return end?.how === 'rolled-back' && end.by === 'martin';
}

/** What the line read for a failed measure: its series and the routes where the canary did worse, or the journeys'. */
export interface Read {
  series?: Series;
  routes?: RoutesWorse;
  /** The checks that regressed, as the journeys Job wrote them; undefined when they could not be read. */
  journeys?: Regression[];
}

/** A key for a failed measure, the same on every pass: its run and its name. */
export const keyOf = (failed: Pick<FailedMeasure, 'run' | 'measure'>) =>
  `${failed.run.metadata.uid}/${failed.measure.name}`;

/** A failed measure's signal, and the id it goes in the inbox under. */
export function canarySignal(failed: FailedMeasure, read: Read): { id: string; signal: InboxSignal } {
  const { run, measure, started } = failed;
  const stands = SYMPTOMS[measure.name] ?? JOURNEY_FALLBACK;
  const first = read.journeys?.[0];
  const worse = read.routes?.worse ?? [];
  const symptom: DefectSymptom = stands === 'journey' ? (first?.symptom ?? JOURNEY_FALLBACK) : stands;
  const routes = stands === 'journey' ? [...new Set(read.journeys?.map((r) => r.route))] : worse.map((r) => r.route);
  const route = routes.length === 1 ? (routes[0] ?? '*') : '*';
  const at =
    run.status.completedAt ??
    run.status.metricResults.find((m) => m.name === measure.name)?.measurements.at(-1)?.finishedAt ??
    run.metadata.creationTimestamp;
  const where = route === '*' ? '' : ` on ${route}`;
  // Judged bad with auto-rollback off, its verdict is the run's: Argo Rollouts says why it was inconclusive there.
  const judged = measure.phase === 'inconclusive';
  const verdict = measure.message ?? (judged ? run.status.message?.trim() || undefined : undefined);
  const how = judged ? ', judged bad and rolled back by Martin' : '';
  const words = verdict ?? (judged ? 'the analysis judged it inconclusive' : 'the analysis failed it');
  const signal: InboxSignal = {
    sense: 'canary',
    check: measure.name,
    route,
    version: started.version,
    symptom,
    evidence: [
      {
        kind: 'canary',
        release: started.release,
        version: started.version,
        against: started.previous,
        measure: verdict && !measure.message ? { ...measure, message: cutTo(verdict, 300) } : measure,
        ...(read.series ? { series: read.series } : {}),
        ...(read.routes?.worse.length ? { routes: read.routes } : {}),
        ...(read.journeys?.length ? { checks: read.journeys } : {}),
      },
    ],
    observedAt: new Date(at).toISOString(),
    summary: cutTo(
      `${short(started.version)} did worse than ${short(started.previous)} on ${measure.name}${where}${how}: ${words}`,
      200,
    ),
    artifacts: [],
  };
  return { id: uuidFrom(`canary:${keyOf(failed)}`), signal };
}
