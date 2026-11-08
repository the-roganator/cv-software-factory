/**
 * Judging a visitor's report: the one thing triage asks a model about. Jev answers `triage/v2` about the report
 * (scrubbed), routing code decides where it goes, and a defect gets a second request where its symptom is about part
 * of the page (`POINTED_BY`): `passage/v1`, which chooses the passage of the page it is about, or `element/v1`, the
 * link, image, field or button, each from the page as the factory read it itself. The ticket then points at the
 * factory's own text and markup, never the visitor's words; a content report's fingerprint is its passage too.
 */
import {
  cutTo,
  elementsOf,
  PAGE_PATH,
  type PageElement,
  type PayloadOf,
  POINTED_BY,
  type Points,
  REPORT_CATEGORIES,
  type ReportCategory,
  type Screenshot,
  SYMPTOM_CLASSES,
  type SymptomClass,
} from '@software-factory/events';
import type { Answer, Judge, JudgeResult, Question } from './judge.ts';
import {
  type Candidate,
  candidateKey,
  ELEMENT,
  elementKey,
  elementQuestions,
  MODEL,
  NONE,
  PASSAGE,
  passageKey,
  passageQuestions,
  type ReportState,
  SEVERITY_LEVELS,
  TRIAGE,
  triageQuestions,
} from './questions.ts';
import { type Routed, type Router, routeReport } from './routing.ts';
import { privatePath, scrub } from './scrub.ts';

/**
 * The page a report names, as the factory sees it: the status it answered with, a screenshot at its path, its text
 * in passages, and its links, images, fields and buttons.
 */
export interface PageView {
  status: number | null;
  screenshot: Screenshot;
  passages: string[];
  elements: PageElement[];
}

/** Reads a page of the app at a path, with no query: that is the visitor's. Null when it cannot be read. */
export type PageReader = (path: string) => Promise<PageView | null>;

export type Judgement = PayloadOf<'judgement.made'>;
export type Fingerprint = PayloadOf<'ticket.opened'>['fingerprint'];

export interface ReportDecision {
  routed: Routed;
  /** One per request to Jev, in order. */
  judgements: Judgement[];
  /**
   * For a defect, a ticket or a planner's finding held: what it is matched by. A content defect's passage is the
   * factory's text from the page.
   */
  fingerprint?: Fingerprint;
  /**
   * For a ticket on a page the factory read, what it points at: the page, and the passage or element Jev chose, if
   * any. Absent when the page could not be read or did not answer, so a path no page has never reaches an agent.
   */
  points?: Points;
  screenshot?: Screenshot;
  /** The scrubbed text, as Jev read it. The only form of the report triage keeps. */
  text: string;
}

export interface Report {
  page: string;
  text: string;
  /** The route the page belongs to, as the app names it. */
  route: string;
}

/**
 * Judges a report, or a planner's finding, which is asked the same questions: `route` decides where each goes from
 * the answers.
 */
export async function judgeReport(
  report: Report,
  candidates: readonly Candidate[],
  judge: Judge,
  read: PageReader,
  route: Router = routeReport,
  /** Whether a ticket may come of it, and so whether to ask what it points at: never for a planner's finding. */
  pointed = true,
): Promise<ReportDecision> {
  const path = privatePath(report.page);
  const state: ReportState = { page: path, report: scrub(report.text) };
  const view = await read(path);

  const questions = triageQuestions(candidates);
  const result = await judge({ agent: 'triage', workItem: null, questionSet: TRIAGE, model: MODEL, state, questions });
  const repeat = result.answers.repeat;
  const routed = route({
    category: label(result, 'category', REPORT_CATEGORIES) as ReportCategory,
    symptom: label(result, 'symptom', SYMPTOM_CLASSES) as SymptomClass,
    severity: answer(result, 'severity', 'score').score,
    injection: answer(result, 'injection', 'noul').noul,
    repeat:
      repeat?.type === 'choice'
        ? {
            workItem: candidates.find((_, i) => candidateKey(i) === repeat.choice)?.workItem ?? null,
            probability: repeat.probabilities[repeat.choice] ?? 0,
          }
        : undefined,
  });

  const judgements: Judgement[] = [
    {
      ...recorded(result, TRIAGE, state, questions),
      ...(candidates.length > 0 && { state: { ...stateOf(state), candidates: candidates.map(offered) } }),
      route: routed.route,
      ...(routed.route === 'repeat' && { joined: routed.joined }),
    },
  ];
  const decision: ReportDecision = {
    routed,
    judgements,
    text: state.report,
    ...(view && { screenshot: view.screenshot }),
  };
  // A defect is fingerprinted as its ticket would be, whether it opens one or, a planner's finding, is held.
  const defect = routed.route === 'ticket' ? routed : routed.route === 'park' ? routed.defect : undefined;
  if (!defect) return decision;

  decision.fingerprint = { route: privatePath(report.route), class: defect.symptom };
  const content = defect.category === 'content';
  // A page that answered, at a path an event may name: only then is the page the app's, and not a path typed.
  const found =
    pointed && view !== null && view.status !== null && view.status >= 200 && view.status < 300 && PAGE_PATH.test(path);
  if (found) decision.points = { page: path };
  const pointing = content ? 'passage' : POINTED_BY[defect.symptom];
  if (pointing === 'passage' && (found || content)) {
    const passages = passagesOf(view?.passages ?? []);
    if (!passages.length) return decision;
    const asked = passageQuestions(passages);
    const chosen = await judge({
      agent: 'triage',
      workItem: null,
      questionSet: PASSAGE,
      model: MODEL,
      state,
      questions: asked,
    });
    judgements.push({
      ...recorded(chosen, PASSAGE, state, asked),
      state: { ...stateOf(state), passages: passages.map((text, i) => ({ key: passageKey(i), text })) },
    });
    const pick = answer(chosen, 'passage', 'choice').choice;
    const passage = passages.find((_, i) => passageKey(i) === pick);
    if (pick === NONE || !passage) return decision;
    if (content) decision.fingerprint = { page: path, text: passage };
    if (decision.points) decision.points.passage = passage;
  } else if (Array.isArray(pointing) && found) {
    const elements = elementsOf(view.elements).filter((e) => pointing.includes(e.kind));
    if (!elements.length) return decision;
    const asked = elementQuestions(elements);
    const chosen = await judge({
      agent: 'triage',
      workItem: null,
      questionSet: ELEMENT,
      model: MODEL,
      state,
      questions: asked,
    });
    judgements.push({
      ...recorded(chosen, ELEMENT, state, asked),
      state: { ...stateOf(state), elements: elements.map((element, i) => ({ key: elementKey(i), element })) },
    });
    const pick = answer(chosen, 'element', 'choice').choice;
    const element = elements.find((_, i) => elementKey(i) === pick);
    if (pick !== NONE && element && decision.points) decision.points.element = element;
  }
  return decision;
}

const stateOf = (state: ReportState): Judgement['state'] => ({ report: { page: state.page, text: state.report } });

const offered = (ticket: Candidate, i: number) => ({
  key: candidateKey(i),
  workItem: ticket.workItem,
  title: ticket.title,
  category: ticket.category,
  ...(ticket.symptom && { symptom: ticket.symptom }),
});

/** A request and its answers, as `judgement.made` records them. */
function recorded(
  result: JudgeResult,
  questionSet: string,
  state: ReportState,
  questions: Record<string, Question>,
): Judgement {
  return {
    questionSet,
    model: result.model,
    state: stateOf(state),
    answers: Object.entries(questions).map(([key, question]) => answerOf(key, question, result.answers[key])),
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    cassette: result.cassette,
  };
}

function answerOf(key: string, question: Question, given: Answer | undefined): Judgement['answers'][number] {
  if (!given || given.type !== question.type) throw new Error(`Jev gave no ${question.type} answer to ${key}`);
  const base = { key, question: question.instructions };
  if (given.type === 'choice')
    return { type: 'choice', ...base, answer: given.choice, probabilities: given.probabilities };
  if (given.type === 'score') {
    const levels = key === 'severity' ? [...SEVERITY_LEVELS] : (question.criteria as string[]).map((_, i) => `${i}`);
    return {
      type: 'score',
      ...base,
      levels,
      probabilities: levels.map((_, i) => given.probabilities[String(i)] ?? 0),
      expected: given.score,
    };
  }
  return { type: 'noul', ...base, probability: given.noul };
}

function answer<T extends Answer['type']>(result: JudgeResult, key: string, type: T): Extract<Answer, { type: T }> {
  const given = result.answers[key];
  if (given?.type !== type) throw new Error(`Jev gave no ${type} answer to ${key}`);
  return given as Extract<Answer, { type: T }>;
}

function label(result: JudgeResult, key: string, labels: readonly string[]): string {
  const { choice } = answer(result, key, 'choice');
  if (!labels.includes(choice)) throw new Error(`Jev answered ${key} with a label it was not offered`);
  return choice;
}

/**
 * Passages as a question may offer them and an event may keep them: whitespace folded, none empty or repeated, each
 * at most 200 characters (a longer one keeps its start), and at most 40.
 */
export function passagesOf(read: readonly string[]): string[] {
  const passages = read
    .map((passage) => passage.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((passage) => cutTo(passage, 200));
  return [...new Set(passages)].slice(0, 40);
}
