/**
 * Where a report goes, from Jev's answers and the policy: plain code, in a fixed order, so a reviewer can read,
 * test and tune it without retraining anything (TYPESAFE.md, "Routing").
 */
import type { DefectCategory, DefectSymptom, ReportCategory, Severity } from '@software-factory/events';
import { REPORTS } from '../../../policy/triage.ts';

/** The answers routing reads, taken from Jev's typed answers. */
export interface ReportAnswers {
  category: ReportCategory;
  symptom: DefectSymptom;
  /** Expected level on the severity rubric: 0 no harm, 1 cosmetic, 2 degraded, 3 broken. */
  severity: number;
  /** The probability that the report holds instructions aimed at the system. */
  injection: number;
  /** The open ticket it most likely repeats, if it was offered any, and how likely. */
  repeat?: { workItem: string | null; probability: number } | undefined;
}

/** What a defect is, as routing reads it from Jev's answers. */
export interface Defect {
  category: DefectCategory;
  symptom: DefectSymptom;
  severity: Severity;
}

export type Routed =
  | { route: 'quarantine' | 'discard' }
  /** Parked for Martin: a suggestion, or a defect the planner alone has seen, which waits for a sense or for him. */
  | { route: 'park'; defect?: Defect }
  | { route: 'repeat'; joined: string }
  | ({ route: 'ticket' } & Defect);

/** Routes a report, or a planner's finding: each by its own rules from the same answers. */
export type Router = (answers: ReportAnswers, policy?: typeof REPORTS) => Routed;

export function routeReport(answers: ReportAnswers, policy = REPORTS): Routed {
  // Instructions first, whatever else the report is: it never reaches anything that acts on it.
  if (answers.injection >= policy.quarantine) return { route: 'quarantine' };
  if (answers.category === 'suggestion') return { route: 'park' };
  if (answers.category === 'not-a-defect') return { route: 'discard' };
  const { repeat } = answers;
  if (repeat?.workItem && repeat.probability >= policy.repeat) return { route: 'repeat', joined: repeat.workItem };
  return {
    route: 'ticket',
    category: answers.category,
    symptom: answers.symptom,
    severity: severityOf(answers.severity, policy),
  };
}

/** A problem report's severity. Below `degraded` it is cosmetic: a defect is never "no harm". */
export function severityOf(expected: number, policy = REPORTS): Severity {
  if (expected >= policy.severity.broken) return 'broken';
  if (expected >= policy.severity.degraded) return 'degraded';
  return 'cosmetic';
}

/**
 * Where a planner's finding goes: as a visitor's report would, except that it never opens a ticket. The planner's
 * words are about the app's public code, which a visitor can read and argue about to persuade an agent, so they are
 * trusted no more than a report and, alone, never make a ticket: a defect is parked, and waits for a sense to see it
 * or for Martin.
 */
export function routeFinding(answers: ReportAnswers, policy = REPORTS): Routed {
  const routed = routeReport(answers, policy);
  if (routed.route !== 'ticket') return routed;
  const { route: _ticket, ...defect } = routed;
  return { route: 'park', defect };
}
