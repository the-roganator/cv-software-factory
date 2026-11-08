/**
 * Runs the evaluation set through triage's own judging and routing, with whatever judge it is given: the gateway
 * replaying committed cassettes in CI, or calling Jev live in `make eval`. For each report it says what triage
 * did, whether that was expected, and how far each deciding probability sat from its threshold.
 */
import { elementWords, type Points, type Screenshot } from '@software-factory/events';
import { type Judge, judgeReport, type ReportDecision } from '@software-factory/triage';
import { REPORTS as POLICY } from '../../../policy/triage.ts';
import { type EvalReport, REPORTS } from './reports.ts';

/** A probability this close to its threshold could cross it on another day: Jev drifted by up to 0.16, with room. */
export const MARGIN = 0.2;

/** A stand-in for the page's screenshot: the evaluation reads passages, never pixels. */
const SCREENSHOT: Screenshot = {
  kind: 'screenshot',
  hash: '0'.repeat(64),
  type: 'image/png',
  size: 1,
  route: '/',
  version: '0000000',
  width: 1,
  height: 1,
  boxes: [],
};

export interface Outcome {
  report: EvalReport;
  got: { route: string; category?: string; joined?: string; passage?: string; point?: string | null };
  pass: boolean;
  /** Each deciding probability, and its distance from the threshold it is compared with (positive is above). */
  deciding: { name: string; p: number; threshold: number; margin: number }[];
  /** The chosen category's probability, and its lead over the next. */
  category?: { label: string; p: number; lead: number };
}

export async function evaluate(judge: Judge, reports: readonly EvalReport[] = REPORTS): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const report of reports) {
    const candidates = (report.tickets ?? []).map((t) => ({ ...t, symptom: undefined }));
    const { passages, elements } = report;
    const decision = await judgeReport(report, candidates, judge, async () =>
      passages || elements
        ? { status: 200, screenshot: SCREENSHOT, passages: passages ?? [], elements: elements ?? [] }
        : null,
    );
    outcomes.push(outcomeOf(report, decision));
  }
  return outcomes;
}

function outcomeOf(report: EvalReport, decision: ReportDecision): Outcome {
  const { routed } = decision;
  const fingerprint = decision.fingerprint;
  const got = {
    route: routed.route,
    ...(routed.route === 'ticket' && { category: routed.category }),
    ...(routed.route === 'repeat' && { joined: routed.joined }),
    ...(fingerprint && 'text' in fingerprint && { passage: fingerprint.text }),
    ...(decision.points && { point: pointOf(decision.points) }),
  };
  const expected = report.expect;
  const either = <T>(want: T | T[] | undefined, value: T | undefined) =>
    want === undefined || (Array.isArray(want) ? want.includes(value as T) : want === value);
  const pass =
    'joined' in expected
      ? got.route === 'repeat' && got.joined === expected.joined
      : either(expected.route, got.route as typeof expected.route & string) &&
        (got.route !== 'ticket' || either(expected.category, got.category as never)) &&
        (got.category !== 'content' || either(expected.passage, got.passage)) &&
        (expected.point === undefined || got.point === expected.point);

  const answers = new Map(decision.judgements[0]?.answers.map((a) => [a.key, a]));
  const deciding: Outcome['deciding'] = [];
  const injection = answers.get('injection');
  if (injection?.type === 'noul') deciding.push(decided('injection', injection.probability, POLICY.quarantine));
  const repeat = answers.get('repeat');
  if (repeat?.type === 'choice' && repeat.answer !== 'none') {
    deciding.push(decided('repeat', repeat.probabilities[repeat.answer] ?? 0, POLICY.repeat));
  }
  const category = answers.get('category');
  const ranked =
    category?.type === 'choice' ? Object.entries(category.probabilities).sort(([, a], [, b]) => b - a) : [];
  return {
    report,
    got,
    pass,
    deciding,
    ...(ranked[0] && {
      category: { label: ranked[0][0], p: ranked[0][1], lead: round(ranked[0][1] - (ranked[1]?.[1] ?? 0)) },
    }),
  };
}

/** What a ticket points at, as the set expects it: a passage's text, an element in words, or null for neither. */
const pointOf = (points: Points) => points.passage ?? (points.element ? elementWords(points.element) : null);

const round = (n: number) => Math.round(n * 1000) / 1000;
const decided = (name: string, p: number, threshold: number) => ({
  name,
  p: round(p),
  threshold,
  margin: round(p - threshold),
});

/** Whether any deciding probability sat within the margin of its threshold. */
export const close = (outcome: Outcome) => outcome.deciding.some((d) => Math.abs(d.margin) < MARGIN);
