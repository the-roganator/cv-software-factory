/**
 * The planner: turns a ticket into a spec the coder can be held to, or says it cannot. It reads the app's repository
 * at the commit the fix will start from, and hands back the spec in the fixed template (`spec.written`): the outcome,
 * Given/When/Then criteria the coder can write as failing tests, the files that may change, risk tags and a rollout
 * note. Or it rejects the ticket, or asks Martin a question, and the work item holds for him.
 *
 * Once Martin has approved its question with no answer (`unanswered`), it is told none will come, and offered no
 * question until it writes a spec or his words reach it, and its schema takes none: it would only ask the same again.
 * It decides from the evidence, a spec or a rejection; a question handed back anyway is a result that does not fit, and
 * fails the step, which is tried again told why, as any other. On a ticket a visitor's report opened, his words reach
 * it only where he shared them, as their author; with none shared, he approves its question or rejects it.
 *
 * What it is told is the ticket's public view and what the senses saw, by their typed fields (`evidence.ts`): never
 * a visitor's words, and never a log message, which may carry them.
 *
 * A fix does what its ticket's evidence asks, and no more: each criterion names what in that evidence it comes from
 * (`from`), and quotes the words there that ask for it (`quote`). The schema refuses a spec whose quote is not in
 * what its criterion names, as the planner was told it, so a criterion the planner widened cannot claim words the
 * evidence never had; whether the words it quotes do ask for the criterion is the reviewer's to judge, with the
 * words in front of it. One nothing asks for does not belong in the spec. Anything else the planner notices on the way goes in
 * its `findings`, which the line leaves in triage's inbox as signals from the planner (`findingSignal`). Triage judges
 * them as it judges a visitor's report, and trusts them no more: a visitor can read the app's public code and try to
 * persuade an agent that a line of it holds a bug, so the planner's word alone never opens a ticket.
 *
 * It stops at a diagnosis: the code at fault, and why. Reproducing the defect (a server, requests, a script) is the
 * coder's, whose first step is a failing test. On Qwen, planners that reproduced it found the cause in a few minutes
 * and spent the rest of their 30 to 45 doing so.
 *
 * An improvement Martin asked for is planned from his words, through the redactor, and his answers, with no signal:
 * where the change goes, not a diagnosis, since nothing is broken. Its spec goes behind a flag of its own, which the
 * app reads with `request.flag`, off until he turns it on; so the schema holds it to a title, a fresh flag (none
 * another improvement named, `flagsTaken`), the pages it changes, and criteria on each side of the flag, each from
 * his words (`improvementProblems`). It rejects a change that needs a protected path, the app's flag context among
 * them, or that would keep anything on a visitor's device. A ticket's first plan says nothing of improvements or
 * replans.
 *
 * A criterion can contradict a test the app already has: a fix that makes every asset cacheable contradicts the test
 * that pins one as never cached. The planner names each such test, by its file and its full name (`contradicts`), and
 * the line writes them into the pull request's description, where test integrity reads them: the change may delete,
 * rename or rewrite those tests, and no other. The planner names them, not the coder, so the coder cannot excuse
 * itself. The schema holds each to a test file the scope takes in, as the gate will read it (`contradictsProblems`),
 * and the line refuses a spec that names a test its file does not have at the commit, where it can read the file
 * (`missingTests`). A spec that names one carries `test-loosening` among its risks, which the line adds if the planner
 * left it out (`tagged`): an agent may add a tag, never take one away.
 *
 * Work can come back to Plan: Martin answers a hold that sends it back (the coder needs files outside the scope, the
 * fence kept refusing its patch, the reviewer found the spec beyond the ticket, the coder found nothing to fix, or he
 * answered the spec or a verification in words), a fix's signal persists after its release, or the ticket reopens.
 * The planner is then told it is planning again: its last spec as it wrote it, and why it came back, in plain words
 * (`replanLines`), and to keep what still holds, each criterion it keeps with its `from` and `quote` word for word.
 * After the change built to that spec merged, nothing of it is to keep: it is on main, the planner's checkout, and
 * its criteria are met there. The planner is told the last spec as what shipped, for what was tried, and to write only
 * criteria that fail at this commit, for what the return asks that the shipped change did not do; the schema refuses
 * a criterion that repeats one of the shipped spec's (`repeatsShipped`), an improvement's `off` side aside, which
 * holds at both. Once the work item has a pull request, the planner's checkout is
 * where that pull request's branch left main (`plansFromBase`), which the change's tests are judged against, not the
 * pull request's head: it is told the pull request holds the work so far, and which files it changes, so it does not
 * take that work for another change's. An improvement planned again keeps its flag, which the schema holds it to:
 * Martin's moves, the baseline and the pictures are recorded against it.
 *
 * Only Martin's own words in an answer are his. What the line reads into an answer (that an approval of a scope hold
 * lets the scope take in the files), and what an agent said that he read with it, are told beside them, and no
 * criterion may quote either (`sourcesOf`). What his answer asks for reaches the coder through the spec alone: the
 * coder is never told the answers at Plan, and the last hold's words, which it is told only when he sends the work
 * back to it, are cleared when a spec is written (`MOVES_ON`), so the planner carries each ask into the spec as a
 * criterion from his answer that quotes his words, a constraint on the change itself (a test's name to keep) as much
 * as a behaviour a page shows. The reviewer holds the spec to his words, and the change to the spec alone: a lack it
 * finds holds as `beyond-ticket` and comes back here with the finding, told as a lack only where his words can be
 * read, which on a work item a visitor's report opened they cannot, unless he shared them (they stay his).
 *
 * A finding is an extra for triage: one that does not fit (a page that is not a path, a field too long, one past the
 * most a plan leaves) is left out, logged and counted in the spec's summary, and the result stands.
 *
 * The planner has the checkout's tools, but nothing it changes leaves the sandbox: the line reads only its result,
 * and the coder's step starts from a fresh checkout. Its scope is held to the line's rules here, by the schema: a
 * plain path in the repository, never naming the workflows, the deployment, or a path the app's CODEOWNERS gives
 * Martin, as the repository has them at that commit. A fix that needs one is not the line's to make, and the planner
 * says so by rejecting the ticket. The line's fence holds the coder's patch to the same paths at its commit
 * (`coder.ts`), and the GitHub worker refuses every protected file a patch changes, as the last word.
 */
import type { InboxSignal, PayloadOf } from '@software-factory/events';
import { inScope, PATH_CHARS, RISKS, touches } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { z } from 'zod';
import { type Contradicted, entryProblem, MOST_CONTRADICTED } from '../../gates/contradicts.ts';
import { TEST_FILE } from '../../gates/files.ts';
import { testsIn } from '../../gates/tests.ts';
import { NEVER, plainPath, protectedWords } from '../../github/paths.ts';
import { type Answer, LIMITS, type Replan, timesOf } from '../machine.ts';
import {
  askedOf,
  count,
  defineAgent,
  type EffectsContext,
  FLAG_NAMES_FILE,
  heAnswered,
  holdDraft,
  StepFailed,
  words,
} from './agent.ts';
import {
  type Asked,
  askedLines,
  askedTitle,
  numbered,
  type Request,
  routeOf,
  type Signal,
  seen,
  ticketLines,
} from './evidence.ts';

export interface PlannerInput {
  workItem: string;
  /** The ticket, or Martin's request for an improvement, as its public view has it. */
  asked: Asked;
  /** What each sense saw, in the order they saw it. A report's signal is not here. */
  signals: Signal[];
  /** The paths no scope may name at the commit: the workflows, the deployment and what CODEOWNERS gives a person. */
  protectedPaths: readonly string[];
  /**
   * Martin's answers to the holds at Plan, each with what he was asked, and what an agent said that he read with it
   * (`said`: the files the coder needs, and why) and what the line reads his answer as (`line`), which the prompt
   * tells and no quote may come from.
   */
  answers: Answer[];
  /** Each verification that found the signal persisting after a fix for this ticket was released. */
  persisted?: PayloadOf<'verification.finished'>[];
  /**
   * Each time the ticket reopened: a fix for it was verified in production, and the same defect came back. Not the
   * line's reopening of a ticket a dry run verified, whose fix never shipped: that says nothing of a fix.
   */
  reopened?: PayloadOf<'work-item.reopened'>[];
  /** Why the planner's last attempt failed, such as a scope its schema refused, so it does not hand that back again. */
  failure?: string | null | undefined;
  /**
   * Whether Martin approved its last question with no answer, since it last wrote a spec: none will come, so it is
   * told so, and offered no question.
   */
  unanswered?: boolean | undefined;
  /**
   * Whether a visitor's report opened the ticket: Martin answers a question there only by making his words public, so
   * it asks only what the app should do, never what the visitor saw or wrote.
   */
  aboutReport?: boolean | undefined;
  /**
   * For an improvement, the flags other improvements Martin asked for have named, open or closed: a closed one's code
   * stays in the app behind its flag, off, so its name is never given to another change.
   */
  flagsTaken?: readonly string[] | undefined;
  /** The spec the planner wrote last, when the work has come back to Plan for another. */
  lastSpec?: PayloadOf<'spec.written'> | undefined;
  /**
   * Whether the change built to the last spec merged into main, which the checkout has: its criteria are met there,
   * so the new spec repeats none of them.
   */
  shipped?: boolean | undefined;
  /** Why the work came back to Plan, when it has. */
  replan?: Replan | undefined;
  /**
   * The work so far, once the work item has a pull request: its number, the files it changes, and the commit the
   * planner's checkout is, where its branch left main, without that work.
   */
  change?: { pullRequest: number; files: string[]; commit: string } | undefined;
}

/** What the planner is told once Martin has approved its question with no answer. */
const UNANSWERED =
  'Martin approved your last question without an answer: none will come, so ask him nothing. Decide from what you have.';

/** Whether the planner may ask Martin a question: not once he approved its last one with no answer (`unanswered`). */
const asksMartin = (input: PlannerInput) => !input.unanswered;

/** What is wrong with a scope entry, if anything: it must be a plain path in the repository, and keep out of the protected paths. */
function scopeProblem(entry: string, protectedPaths: readonly string[]): string | undefined {
  // A folder ends in its slash; the rest of it is a path like any other.
  if (!plainPath(entry.endsWith('/') ? entry.slice(0, -1) : entry))
    return `${entry} is not a plain path in the repository`;
  if (touches(entry, protectedPaths)) return `${entry} names a path no patch may change`;
  return undefined;
}

/**
 * What a criterion may come from, in the words the prompt gives each: the ticket, or Martin's request, each signal by
 * its number from 1, and Martin's answers with what he was asked. A criterion's quote is looked for here.
 */
export interface Sources {
  /** Which the work item has: a ticket, or Martin's request. A criterion may name only the one it has. */
  kind: Asked['kind'];
  /** The ticket, or Martin's request, as the prompt tells it. */
  asked: string;
  signals: string[];
  answers: string;
}

/**
 * What he was asked, as a sentence: a hold's reason has no full stop of its own, and his words are told after it. One
 * that ends a sentence already, a closing quote or bracket after it, keeps its own.
 */
const stopped = (asked: string) => {
  const trimmed = asked.trimEnd();
  return /[.?!…]['"’”)\]]*$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * One of Martin's answers, with what he was asked, as a quote is looked for in it: his own words, never an agent's
 * nor the line's. An approval in no words of his gives a quote nothing.
 */
const answered = (a: Answer) => (a.answer ? `${stopped(a.asked)} He said: ${a.answer}` : '');

/** One of Martin's answers as the prompt tells it: with what an agent said that he read with it, and the line's reading. */
const told = (a: Answer) => [stopped(a.asked), a.said, heAnswered(a)].filter(Boolean).join(' ');

/**
 * Martin's answers as the prompt tells them; that everything they ask for goes into the spec, since the coder reads
 * the spec and never his answers; and, when any carries words not his, which of them a criterion may quote.
 */
function answerLines(answers: readonly Answer[]): string[] {
  if (!answers.length) return [];
  const notHis = answers.some((a) => a.said || a.line || !a.answer);
  return [
    '',
    'Martin was asked, and answered:',
    ...answers.map((a) => `- ${told(a)}`),
    'Everything his answer asks for goes into the spec, as a criterion from Martin’s answer that quotes his words: an ask about the change itself that no page shows too, such as a test or a file to keep as it is, or its name. The coder reads the spec and never his answer, and is held to nothing the spec does not say.',
    ...(notHis
      ? [
          'Only his own words, after “He said:”, are his answer, which a criterion from Martin’s answer may quote, with what he was asked. What the coder said, and what the line reads his answer as, are not his words: no criterion quotes them.',
        ]
      : []),
  ];
}

/** The sources of a plan's input, as its prompt tells them. */
export const sourcesOf = ({
  asked,
  signals,
  answers,
}: Pick<PlannerInput, 'asked' | 'signals' | 'answers'>): Sources => ({
  kind: asked.kind,
  asked: [askedTitle(asked), ...askedLines(asked, signals)].join('\n'),
  signals: signals.map((signal) => seen(signal).join('\n')),
  answers: answers.map(answered).filter(Boolean).join('\n'),
});

/** No sources at all: every quote is refused. */
const NOTHING: Sources = { kind: 'ticket', asked: '', signals: [], answers: '' };

/**
 * Words as a quote is matched: in one case, with one kind of apostrophe and quotation mark, and one space between
 * words. A quote may come in quotation marks, and end in a full stop or other mark the evidence does not have there.
 */
const plain = (words: string) =>
  words.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const unquoted = (quote: string) =>
  plain(quote)
    .replace(/^["'([{]+|["'.,;:!?)\]}…]+$/g, '')
    .trim();

/** Whether words are in a source as whole words: never the inside of a word, which would let a few letters pass. */
const within = (words: string, source: string) => {
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(plain(source));
};

/**
 * What is wrong with a criterion's `from` and `quote`, if anything: `from` names the ticket, a signal there is by its
 * number, or Martin's answer when he has given one, and the quote, word for word, is in one of the sources it names.
 */
export function quoteProblem(from: string, quote: string, sources: Sources): string | undefined {
  const named: string[] = [];
  // A ticket's criterion names the ticket, and an improvement's the request: never the one the work item has not.
  if ((sources.kind === 'ticket' ? /\bticket\b/i : /\brequest\b/i).test(from)) named.push(sources.asked);
  // `signal 2`, `signals 1 and 2`, `signals 1, 3`, `signal #2`
  for (const [, list = ''] of from.matchAll(/\bsignals?\s*((?:#?\d+(?:\s*(?:,|and|&|\+|-|–)\s*)?)+)/gi)) {
    for (const [n] of list.matchAll(/\d+/g)) {
      const signal = sources.signals[Number(n) - 1];
      if (signal === undefined) return `there is no signal ${n}`;
      named.push(signal);
    }
  }
  if (/\banswer/i.test(from)) {
    if (!sources.answers) return 'Martin has answered nothing yet';
    named.push(sources.answers);
  }
  if (!named.length) {
    return sources.kind === 'ticket'
      ? 'from names the ticket, a signal by its number, or Martin’s answer'
      : 'from names the request, or Martin’s answer';
  }
  const words = unquoted(quote);
  if (words.split(' ').length < 2) return 'a quote is the words that ask for the criterion: two or more of them';
  if (!named.some((source) => within(words, source)))
    return `the quote is not in ${from}: copy the words that ask for the criterion from there, word for word`;
  return undefined;
}

/**
 * The spec, with a scope of plain paths that keeps out of the protected paths, and every criterion naming what in the
 * ticket's evidence it comes from, and quoting the words there that ask for it.
 */
const specWithin = (
  protectedPaths: readonly string[],
  sources: Sources,
  improvement: Improvement | undefined,
  shipped: PayloadOf<'spec.written'> | undefined,
) =>
  z.preprocess(
    noneContradicted,
    PAYLOADS['spec.written'].superRefine((spec, ctx) => {
      if (improvement) improvementProblems(spec, improvement, ctx);
      if (shipped) repeatsShipped(spec, shipped, ctx);
      spec.scope.forEach((entry, i) => {
        const problem = scopeProblem(entry, protectedPaths);
        if (problem) ctx.addIssue({ code: 'custom', path: ['scope', i], message: problem });
      });
      contradictsProblems(spec, protectedPaths, ctx);
      spec.criteria.forEach((criterion, i) => {
        if (!criterion.from) {
          const message = 'a criterion names what in the ticket or the signals asks for it';
          ctx.addIssue({ code: 'custom', path: ['criteria', i, 'from'], message });
        } else if (!criterion.quote) {
          const message = 'a criterion quotes the words in what it is from that ask for it';
          ctx.addIssue({ code: 'custom', path: ['criteria', i, 'quote'], message });
        } else {
          const problem = quoteProblem(criterion.from, criterion.quote, sources);
          if (problem) ctx.addIssue({ code: 'custom', path: ['criteria', i, 'quote'], message: problem });
        }
      });
    }),
  );

/**
 * A criterion as a repeat of another is looked for: what it is given, when, and what it expects, in plain words, and
 * the side of an improvement's flag it holds on, as the same words with the flag on and off are two claims.
 */
const claimOf = (c: PayloadOf<'spec.written'>['criteria'][number]) =>
  [c.withFlag ?? '', ...[c.given, c.when, c.expect].map((part) => unquoted(part))].join('\n');

/**
 * Refuses each criterion of a spec written after its last spec's change merged that repeats one of that spec's: those
 * are met on main, which the planner's checkout is, so a test of one passes before the fix and shows nothing. An
 * improvement's `off` criterion, which says the pages are as they are now, holds at both commits, and may repeat.
 */
function repeatsShipped(spec: PayloadOf<'spec.written'>, shipped: PayloadOf<'spec.written'>, ctx: z.RefinementCtx) {
  const met = shipped.criteria.map(claimOf);
  spec.criteria.forEach((criterion, i) => {
    if (criterion.withFlag === 'off') return;
    const n = met.indexOf(claimOf(criterion));
    if (n < 0) return;
    const message = `this is criterion ${n + 1} of the spec that shipped, which main meets: write only criteria that fail at this commit`;
    ctx.addIssue({ code: 'custom', path: ['criteria', i], message });
  });
}

/** A spec that contradicts no test says so by leaving `contradicts` out: an empty list is read the same. */
function noneContradicted(spec: unknown): unknown {
  if (typeof spec !== 'object' || spec === null || !('contradicts' in spec)) return spec;
  const { contradicts, ...rest } = spec as { contradicts: unknown };
  return Array.isArray(contradicts) && contradicts.length === 0 ? rest : spec;
}

/**
 * What is wrong with the tests a spec says it contradicts, if anything: each must be one the gate can read
 * (`entryProblem`), in a test file the scope takes in and no protected path, and named once.
 */
function contradictsProblems(spec: PayloadOf<'spec.written'>, protectedPaths: readonly string[], ctx: z.RefinementCtx) {
  (spec.contradicts ?? []).forEach((entry, i) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['contradicts', i], message });
    const problem = entryProblem(entry);
    if (problem) issue(`the test cannot be named: ${problem}`);
    else if (!inScope(entry.file, spec.scope))
      issue(`${entry.file} is not in the scope: a test it contradicts is one the change may change`);
    else if (touches(entry.file, protectedPaths)) issue(`${entry.file} names a path no patch may change`);
    // A file the gate compares: a helper under test/ holds no test it reads.
    else if (!TEST_FILE.test(entry.file)) issue(`${entry.file} is not a test file: name a test in one`);
    else if (spec.contradicts?.findIndex((e) => e.file === entry.file && e.test === entry.test) !== i) {
      issue(`${entry.test} in ${entry.file} is named twice`);
    }
  });
}

/**
 * A spec with the tag that says it changes an existing test's assertions, if it names a test it contradicts and the
 * planner did not tag it so. The line adds it: the tag follows from the list, whatever the planner wrote.
 */
export function tagged(spec: PayloadOf<'spec.written'>): PayloadOf<'spec.written'> {
  if (!spec.contradicts?.length || spec.risks.includes('test-loosening')) return spec;
  return { ...spec, risks: ['test-loosening', ...spec.risks] };
}

/**
 * The tests a spec names that are not in their files at the commit, as test integrity will read the base: each file
 * read through the GitHub worker. A file it cannot read as text is left to the gate, which reports an entry that
 * names no test in the base; a file that is not there names no test at all.
 */
export async function missingTests(
  contradicts: readonly Contradicted[],
  read: (path: string) => Promise<{ found: false } | { found: true; text: string | null }>,
): Promise<string[]> {
  const files = [...new Set(contradicts.map((entry) => entry.file))];
  const reads = await Promise.all(files.map(async (file) => [file, await read(file)] as const));
  const missing: string[] = [];
  for (const [file, at] of reads) {
    if (at.found && at.text === null) continue;
    const names = new Set(at.found && at.text !== null ? testsIn(at.text).map((t) => t.name) : []);
    for (const entry of contradicts) {
      if (entry.file !== file || names.has(entry.test)) continue;
      missing.push(at.found ? `${file} has no test named “${entry.test}”` : `there is no file ${file}`);
    }
  }
  return missing;
}

/** Refuses a spec that names a test its file does not have at the step's commit. */
async function checkContradicted(spec: PayloadOf<'spec.written'>, context: EffectsContext): Promise<void> {
  if (!spec.contradicts?.length) return;
  const missing = await missingTests(spec.contradicts, (path) => context.read('file', { ref: context.commit, path }));
  if (missing.length) {
    const said = missing.slice(0, 3).join('; ');
    throw new StepFailed(
      `The planner’s spec names tests it contradicts that are not there at ${context.commit.slice(0, 7)}: ${said}. Name each by its file and its full name, as the file has it`,
    );
  }
}

/** What an improvement's spec is held to beyond a fix's: the flags it may not take, and the one it keeps. */
export interface Improvement {
  /** The flags other improvements have named. */
  flagsTaken: readonly string[];
  /** The flag its last spec named, which a spec written again keeps. */
  keeps?: string | undefined;
}

/**
 * What an improvement's spec must have that a fix's need not. It ships behind a flag of its own, off, and Verify
 * pictures the pages it changes: so it names its title, its flag, a fresh one, and its pages, or the line would hand
 * over a change with nothing to widen or turn off. Each criterion holds on one side of the flag, and there is one on
 * each: with it on, the change; with it off, the app as it was, which is what keeps the change off until Martin
 * widens it. Each comes from what Martin asked: his request, or his answer.
 */
function improvementProblems(
  spec: PayloadOf<'spec.written'>,
  { flagsTaken, keeps }: Improvement,
  ctx: z.RefinementCtx,
) {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (spec.title === undefined) issue(['title'], 'an improvement’s spec names it, in a few words');
  if (spec.flag === undefined) issue(['flag'], 'an improvement’s spec names the flag its change goes behind');
  else if (keeps !== undefined && spec.flag !== keeps) {
    issue(['flag'], `the improvement’s flag is ${keeps}, as its last spec named it: keep it`);
  } else if (keeps === undefined && flagsTaken.includes(spec.flag)) {
    issue(['flag'], `another improvement has named ${spec.flag}: give this one a flag of its own`);
  }
  if (spec.pages === undefined) issue(['pages'], 'an improvement’s spec names the pages its change shows on');
  spec.criteria.forEach((criterion, i) => {
    if (criterion.withFlag === undefined) {
      issue(['criteria', i, 'withFlag'], 'each criterion of an improvement says the side of its flag: on or off');
    }
  });
  if (!inScope(FLAG_NAMES_FILE, spec.scope)) {
    issue(['scope'], `an improvement’s scope takes in ${FLAG_NAMES_FILE}, where the coder adds its flag’s name`);
  }
  for (const side of ['on', 'off'] as const) {
    if (!spec.criteria.some((c) => c.withFlag === side)) {
      issue(['criteria'], `an improvement’s spec has a criterion with its flag ${side}`);
    }
  }
}

/** The most findings one plan leaves triage. */
export const MAX_PLANNER_FINDINGS = 5;

/**
 * A path of the app: a page a visitor opens, or a route as the app's code names it. A query or fragment is cut off
 * rather than refused, as `findingSignal` would cut it (a query alone is `/`; nothing at all is still refused), so
 * one finding that names one does not cost the whole result: the query is the model's choice, and goes no further
 * than the finding's text, which triage reads as untrusted.
 */
const path = (example: string) =>
  z
    .string()
    .max(1000)
    .transform((value) => (value.trim() ? routeOf(value.trim()).trim() : ''))
    .pipe(
      z
        .string()
        .regex(/^\/\S*$/, `a path such as ${example}`)
        .max(200),
    );

/**
 * Something the planner noticed that its ticket does not ask for: where it shows, as a page and as the route that
 * serves it (as a visitor's report has both), and what it is, in its own words. Triage reads the words as it reads a
 * visitor's report: as untrusted data.
 */
const finding = z.strictObject({
  page: path('/products/camera'),
  route: path('/products/:slug'),
  text: words(300),
});

export type PlannerFinding = z.infer<typeof finding>;

/**
 * The findings that fit, up to the most a plan leaves; each that does not is left out, with why, rather than
 * refusing the result it came in: a finding is an extra for triage, and the spec beside it stands without it.
 */
const findings = z
  .array(z.unknown())
  .default([])
  .transform((given) => {
    const kept: PlannerFinding[] = [];
    const dropped: string[] = [];
    given.forEach((item, i) => {
      const parsed = finding.safeParse(item);
      if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'finding'}: ${issue.message}`);
        dropped.push(`findings.${i}: ${problems.slice(0, 2).join('; ')}`);
      } else if (kept.length >= MAX_PLANNER_FINDINGS) {
        dropped.push(`findings.${i}: past the ${MAX_PLANNER_FINDINGS} a plan may leave`);
      } else kept.push(parsed.data);
    });
    return { kept, dropped };
  });

type Sorted = { kept: PlannerFinding[]; dropped: string[] };

/** A verdict, each of the union's alike, with the findings that fit, and why each other was left out, if one was. */
type WithFindings<T> = T extends { findings: Sorted }
  ? Omit<T, 'findings'> & { findings: PlannerFinding[]; dropped?: string[] }
  : never;

const withFindings = <T extends { findings: Sorted }>(result: T): WithFindings<T> => {
  const { kept, dropped } = result.findings;
  return { ...result, findings: kept, ...(dropped.length ? { dropped } : {}) } as unknown as WithFindings<T>;
};

/**
 * The planner's result, with its scope held to the protected paths given; with none, to the rules of the line that
 * hold whatever the repository's CODEOWNERS says. Its criteria quote the sources given (`sourcesOf`); with none, no
 * spec fits. A question fits only while Martin has not approved its last one with no answer (`asks`, from
 * `unanswered`). After its last spec's change merged (`shipped`), no criterion repeats one of that spec's.
 */
export const plannerResult = (
  protectedPaths: readonly string[] = NEVER,
  sources: Sources = NOTHING,
  improvement?: Improvement,
  asks = true,
  shipped?: PayloadOf<'spec.written'>,
) =>
  z
    .discriminatedUnion('verdict', [
      z.strictObject({
        verdict: z.literal('spec'),
        spec: specWithin(protectedPaths, sources, improvement, shipped),
        findings,
      }),
      /**
       * The ticket cannot be made testable, is not a defect in the app, or needs a fix the line may not make; or the
       * improvement needs a change the line may not make.
       */
      z.strictObject({ verdict: z.literal('reject'), reason: words(300), findings }),
      /** Something about what the app should do that only Martin can say. */
      ...(asks ? [z.strictObject({ verdict: z.literal('question'), question: words(300), findings })] : []),
    ])
    .transform(withFindings);

export type PlannerResult = z.infer<ReturnType<typeof plannerResult>>;

/** What each risk tag says of a fix, so the planner tags what the fix does, not what the defect did. */
const RISK_MEANINGS: Record<(typeof RISKS)[number], string> = {
  'test-loosening':
    'it changes or removes an assertion an existing test makes, as every spec that names a test it contradicts does',
  'dependency-change': 'it adds, removes or updates a dependency',
  'security-headers': 'it changes the headers the app sends',
  'out-of-scope': 'it changes behaviour beyond what the ticket is about',
};

/**
 * How the planner names the existing tests its criteria contradict: by file and full name, as test integrity names
 * them, usually none. The coder may change those and no other.
 */
const CONTRADICTS_RULE = `- \`contradicts\`: the existing tests a criterion contradicts, which the change must delete, rename or rewrite to meet it; usually there are none, and the list is empty. A test contradicts a criterion when it asserts what the criterion says must change, so it fails once the change is in. Name each as {"file","test"}: the test file's path from the top of the repository, which the scope takes in, and the test's full name, the names of the \`describe\` blocks around it and its own, joined with " > ", such as "files > keeps nothing of the other files". At most ${MOST_CONTRADICTED}, each a test the file has at this commit, word for word. The coder may change these tests and no other: the test integrity gate fails a change to any test you do not name, and Martin is told of each you do.`;

const SPEC_TEMPLATE = [
  '- `outcome`: one sentence, what is true once the fix is in.',
  '- `criteria`: one to twelve acceptance criteria, each an object of `given`, `when`, `expect` (the then), `from` and `quote`, in a sentence each. A criterion says what a visitor or a caller of the code sees, not how the code changes. Each is a test the coder can write with the repository’s own tests: it fails at this commit and passes once the fix is in. One from Martin’s answer about the change itself, such as a test’s name to keep, is shown instead by the test or file it names, kept or rewritten as his words ask. `from` names what above asks for it: `the ticket`, a signal by its number (`signal 1`), or `Martin’s answer`. `quote` copies, word for word, the words there that ask for it: two or more, in one unbroken stretch with nothing left out, at most 200 characters; the line refuses a spec whose quote is not in what its criterion names. A criterion nothing above asks for does not belong in the spec, however wrong the code it would mend.',
  '- `scope`: the files the coder may change, its tests among them, and no more than the fix needs: a path from the top of the repository, a folder ending in `/`, or a pattern with `*`.',
  CONTRADICTS_RULE,
  `- \`risks\`: a list of tags, each exactly one of these words, for what the fix itself does; usually it is empty. ${RISKS.map((r) => `${r}: ${RISK_MEANINGS[r]}`).join('; ')}.`,
  '- `rollout`: a sentence or two on how the fix ships and what would show it worked.',
  `Every string is a plain sentence or a path, at most ${PATH_CHARS} characters (the rollout 300).`,
];

/**
 * A planner's finding as a signal for triage's inbox: its own source, with its words where a report's are, which no
 * public view and no generative agent reads. It names the ticket being planned and the commit the planner read.
 */
export function findingSignal(
  found: PlannerFinding,
  workItem: string,
  commit: string,
): Omit<InboxSignal, 'observedAt'> {
  return {
    sense: 'planner',
    check: `planning ticket #${workItem}`,
    route: routeOf(found.route),
    version: commit,
    report: { page: routeOf(found.page), text: found.text },
    planning: workItem,
    artifacts: [],
  };
}

/** What his answer asks for goes into the spec, since the coder is told nothing of it: said once, by every cause he answered in words. */
const CARRIED =
  'Everything his answer asks for is carried into the spec as criteria from Martin’s answer that quote his words, since the coder is told nothing of his answer.';

/**
 * What Martin did with the hold that sent the work back, as the prompt says it, and what a cause adds to that (`then`);
 * when he answered in words, that everything they ask for goes into the spec.
 */
function heDid(replan: Extract<Replan, { approved: boolean }>, then?: string): string {
  const did = replan.approved
    ? `Martin approved that${replan.answered ? ', with the words last among his answers above' : ''}.`
    : replan.answered
      ? 'Martin answered it in words: the last of his answers above.'
      : 'Martin sent it back to you.';
  return [did, then, replan.answered ? CARRIED : undefined].filter(Boolean).join(' ');
}

/** Where a change was held that Martin sent back to the planner rather than the coder. */
const HELD_AT = {
  gates: 'at the gates',
  review: 'at review',
  merge: 'for his merge',
  'tests-first': 'as its new tests pass without the fix',
} as const;

/**
 * Why the work came back to Plan, in plain words, by its cause, and what to change for it. A lack of what his answer
 * asks is told only where the planner can read any words of his (`hisWords`): on a work item a visitor's report
 * opened, unless he shared them, they stay his, so none can be lacked. Held after the coder's work and sent back, then
 * merged by Martin all the same (`shipped`), nothing of the spec is kept: the change it built is on main.
 */
function whyBack(replan: Replan, asked: Asked['kind'], hisWords: boolean, shipped: boolean): string[] {
  const it = asked === 'ticket' ? 'the ticket' : 'what Martin asked';
  switch (replan.cause) {
    case 'returned':
      return [`Why it came back: the work returned from ${replan.from}: ${replan.reason.replace(/[.\s]+$/, '')}.`];
    case 'reopened':
      return ['Why it came back: the ticket reopened, as said above.'];
    case 'scope':
      if (replan.needs) {
        return [
          'Why it came back: the coder could not meet your criteria without changing files outside your scope, and changed nothing. It named each, and why:',
          ...replan.needs.map(
            ({ path, reason, barred }) => `- ${path}${barred ? ', which no scope may name' : ''}: ${reason}`,
          ),
          heDid(replan),
          `So take into the scope each of those files a scope may name, and keep the rest of the spec as it is${replan.answered ? ', unless his words ask for more' : ''}. A file no scope may name stays out of it: if the work needs one, reject it.`,
        ];
      }
      return [
        `Why it came back: the scope fence refused the coder’s patch ${timesOf(LIMITS.fenceRefusals)}, as it changed files outside your scope.${replan.fenced ? ` The fence printed: ${replan.fenced.split('\n').join('; ')}.` : ''}`,
        heDid(replan),
        `So put the scope right for what the criteria need${replan.answered ? ', as his answer says' : ''}, and keep the rest of the spec as it is.`,
      ];
    case 'beyond-ticket': {
      const found = `the reviewer found the spec, or the change, goes beyond ${it}${hisWords ? ', or that the spec lacks what his answer asks' : ''}`;
      const listed = hisWords
        ? ', each finding saying which, and one for a lack naming the criterion the change was meeting, which stays:'
        : ':';
      return [
        `Why it came back: ${found}${replan.beyond?.length ? listed : `: ${replan.reason}`}`,
        ...(replan.beyond ?? []).map((f) => `- Criterion ${f.criterion}: ${f.comment}`),
        heDid(replan),
        hisWords
          ? `So take out what goes beyond ${it}, or carry in what his answer asks and the spec lacks, as each finding and his answer say, and keep the rest of the spec as it is.`
          : `So take out what goes beyond ${it}${replan.beyond?.length ? ', as each finding says' : ''}, and keep the rest of the spec as it is.`,
      ];
    }
    case 'nothing-to-fix':
      return [
        `Why it came back: the coder found nothing to fix at your spec: ${replan.reason.replace(/[.\s]+$/, '')}.`,
        heDid(replan),
      ];
    case 'spec':
      return [
        'Why it came back: Martin read your last spec and did not approve it.',
        heDid(replan),
        replan.answered
          ? 'So change the spec as his answer asks, and keep the rest of it as it is.'
          : 'His words stay his, so you are not told them: change what in the spec you judge kept it from his approval, and keep the rest of it as it is.',
      ];
    case 'verify':
      return [
        `Why it came back: the change was merged and released, and at Verify it was held for Martin: ${replan.reason.replace(/[.\s]+$/, '')}.`,
        heDid(replan),
      ];
    // Held after the coder's work, where his words would have gone to the coder: he sent them to you instead, as the
    // spec is what he judges wrong.
    case 'gates':
    case 'review':
    case 'merge':
    case 'tests-first':
      return [
        `Why it came back: the change was held for Martin ${HELD_AT[replan.cause]}: ${replan.reason.replace(/[.\s]+$/, '')}.`,
        heDid(replan, 'He sent it to you rather than to the coder: the spec is what he judges must change.'),
        `So change the spec ${replan.answered ? 'as his answer asks' : 'for why it was held'}${shipped ? '' : ', and keep the rest of it as it is'}. Where a criterion means an existing test must change, name that test in \`contradicts\`.`,
      ];
    default:
      return [`Why it came back: it was held for Martin: ${replan.reason.replace(/[.\s]+$/, '')}.`, heDid(replan)];
  }
}

/**
 * What the planner is told when the work has come back to it: its last spec, as it wrote it, why the work came back,
 * the pull request that holds the work so far, and to keep what still holds. After that spec's change merged, the
 * spec is what shipped, met on main, and none of it is kept. Nothing on a first plan.
 */
function replanLines({ asked, lastSpec, shipped, replan, change, answers }: PlannerInput): string[] {
  if (!lastSpec) return [];
  const kind = asked.kind === 'ticket' ? 'ticket' : 'improvement';
  const flag = asked.kind === 'request' && lastSpec.flag ? ` The flag stays \`${lastSpec.flag}\`.` : '';
  return [
    '',
    shipped
      ? `This is a replan: you planned this ${kind} before, the change built to your last spec was merged, and the work came back to you. That change is on main, and in your checkout. Your last spec, for what was built and shipped:`
      : `This is a replan: you planned this ${kind} before, and the work came back to you. Your last spec, as you wrote it:`,
    '```json',
    JSON.stringify(lastSpec, null, 2),
    '```',
    ...(replan
      ? whyBack(
          replan,
          asked.kind,
          answers.some((a) => a.answer),
          shipped === true,
        )
      : []),
    ...(change
      ? [
          `Pull request #${change.pullRequest} holds the work so far, which is this ${kind}’s own: no other change’s. It changes ${change.files.length ? change.files.join(', ') : 'no file yet'}. Your checkout is not that work: it is ${change.commit}, where the pull request’s branch left main, which the coder’s tests are judged against, as your first plan was. Plan against this commit: what the pull request adds is not in it.`,
        ]
      : []),
    shipped
      ? `Its criteria are met at this commit, so none of them is this spec’s: repeat none of them. Write only criteria that fail at this commit, for what the return asks that the shipped change did not do${asked.kind === 'request' ? ', beside the `off` criterion that the pages are as they are now with the flag off' : ''}.${flag}`
      : `Keep what still holds, and change only what the return asks for. A criterion you keep keeps its \`from\` and its \`quote\`, word for word.${flag}`,
  ];
}

/** A fix's plan: the ticket, what the senses saw and what came of fixes before, to a diagnosis and a spec. */
function ticketPrompt(input: PlannerInput, ticket: PayloadOf<'ticket.opened'>): string {
  const { workItem, signals, protectedPaths, answers, persisted = [], reopened = [], failure } = input;
  const asks = asksMartin(input);
  return [
    `Plan the fix for ticket #${workItem}: ${ticket.title}.`,
    ...ticketLines(ticket, signals),
    ...(signals.length ? ['', 'What the senses saw, by number:', ...numbered(signals)] : []),
    ...answerLines(answers),
    ...(persisted.length
      ? [
          '',
          'A fix for this ticket was merged and released before, and the signal persisted:',
          ...persisted.map(
            (v) => `- The ${v.sense ?? 'sense'} still saw “${v.check}” on ${v.version ?? 'the new version'}.`,
          ),
          'Find out why that fix did not clear it before you plan another.',
        ]
      : []),
    ...(reopened.length
      ? [
          '',
          'A fix for this ticket was verified in production before, and the defect came back:',
          ...reopened.map((r) => `- The ${r.sense} saw “${r.check}” again on ${r.version}.`),
          'Find out what brought it back, and what let it through, before you plan another fix.',
        ]
      : []),
    ...replanLines(input),
    ...(failure ? ['', `Your last attempt at this plan failed: ${failure}. Do not hand back the same again.`] : []),
    '',
    'Find the cause in the repository: start from the route, and read the code that serves it and its tests. Stop as soon as you can name the code at fault and say why it does what the evidence shows: that diagnosis is all the plan needs, and most plans need a dozen tool calls or fewer.',
    'Do not reproduce the defect: start no server, send no requests, write no scripts, and run no tests. The coder’s first step is a failing test that reproduces it, and your criteria say what that test shows. You plan; the coder fixes. Change nothing: no change of yours leaves this checkout.',
    '',
    'A fix does what the ticket’s evidence asks, and no more. The app is full of other defects: anything else you notice that is wrong with it, or that it could do better, goes in `findings`, never in the spec. Triage judges each one as it judges a visitor’s report; it opens no ticket on your word alone. Leave `findings` empty when you noticed nothing else.',
    '',
    ...(!asks
      ? [
          UNANSWERED,
          'Where the fix would turn on what the app should do, which only Martin can say, reject it, and say what he would have to decide.',
          '',
        ]
      : []),
    `Then write the result, one of ${asks ? 'three' : 'two'}, each with its \`findings\`:`,
    '1. {"verdict":"spec","spec":{"outcome","criteria":[{"given","when","expect","from","quote"}],"scope":[],"contradicts":[],"risks":[],"rollout"},"findings":[{"page","route","text"}]}, the spec the coder will be held to:',
    ...SPEC_TEMPLATE.map((line) => `   ${line}`),
    `2. {"verdict":"reject","reason"} when you cannot make it testable: the cause is not in this repository, or you cannot find the defect the evidence shows, or no test could tell the fix from the defect. Reject it too when the fix needs a path no scope may name: ${protectedWords(protectedPaths).join(', ')}. The reason is one or two short sentences for Martin, at most 300 characters, naming the file or what is missing.`,
    ...(asks
      ? [
          '3. {"verdict":"question","question"} when the fix turns on what the app should do, which only Martin can say: one question he can answer in a line, at most 300 characters.',
          ...(input.aboutReport
            ? [
                '   A visitor’s report opened this ticket, and Martin can answer only by making his words public: ask what the app should do, never what the visitor saw or wrote.',
              ]
            : []),
        ]
      : []),
    `\`findings\`: at most ${MAX_PLANNER_FINDINGS}, each with \`page\`, a page of the app that shows it, as the path a visitor opens, without its query (\`/\` when it shows on none); \`route\`, the route that serves that page, as the app’s code names it, such as \`/products/:slug\`; and \`text\`, what is wrong or could be better, in a sentence or two of at most 300 characters, with the query if it shows only with one.`,
  ].join('\n');
}

/** What each risk tag says of an improvement's change. */
const IMPROVEMENT_RISK_MEANINGS: Record<(typeof RISKS)[number], string> = {
  ...RISK_MEANINGS,
  'out-of-scope': 'it changes behaviour beyond what Martin asked',
};

/** The flag an improvement's spec names: a fresh one, or, planned again, the one its last spec named. */
function flagRule(flagsTaken: readonly string[], keeps: string | undefined): string {
  const named =
    '- `flag`: the name of the flag the change goes behind: lower-case letters and digits, in words joined by hyphens, at most 100 characters, such as `sort-by-price`.';
  if (keeps) {
    return `${named.replace(/, such as `sort-by-price`\.$/, '.')} Planned again, it is \`${keeps}\`, as your last spec named it, and stays so: Martin’s moves, the baseline and the pictures of the pages are all recorded against it. It is this improvement’s own.`;
  }
  return `${named} A fresh one, which no other change uses: never \`flag-set-revision\`${flagsTaken.length ? `, and none of these, which other improvements have named: ${flagsTaken.map((f) => `\`${f}\``).join(', ')}` : ''}.`;
}

/** The spec an improvement is held to: a fix's, with its title, its flag, its pages and each criterion's side. */
const improvementTemplate = (flagsTaken: readonly string[], keeps?: string) => [
  '- `title`: what the work item is, in a few words, at most 120 characters, such as "Sort the products by price". It names the work item from here on, in place of the one made from Martin’s first sentence.',
  '- `outcome`: one sentence, what a visitor sees once the flag is on.',
  flagRule(flagsTaken, keeps),
  '- `pages`: one to six pages of the app a visitor opens to see the change, each as the path from the root without a query, such as `/products/blue-mug` for a product’s page: Verify takes pictures of them with the flag off and on.',
  '- `criteria`: one to twelve acceptance criteria, each an object of `given`, `when`, `expect` (the then), `withFlag`, `from` and `quote`, in a sentence each. A criterion says what a visitor or a caller of the code sees, not how the code changes. `withFlag` is the side of the flag it holds on: `on` for what the change does, `off` for what stays as it is now. Give at least one of each: one `off` criterion says that, with the flag off, the pages are exactly as they are now. Each is a test the coder can write with the repository’s own tests, with the flag as its side says: an `on` criterion fails at this commit and passes once the change is in; an `off` one passes at both. One from Martin’s answer about the change itself, such as a test’s name to keep, is shown instead by the test or file it names, kept or rewritten as his words ask. `from` names what above asks for it: `the request`, or `Martin’s answer`. `quote` copies, word for word, the words there that ask for it: two or more, in one unbroken stretch with nothing left out, at most 200 characters; the line refuses a spec whose quote is not in what its criterion names. An `off` criterion quotes the words of the request whose change it keeps back, since Martin asked for the change and not for the flag: never these instructions. A criterion Martin did not ask for does not belong in the spec, however much better it would make the app.',
  `- \`scope\`: the files the coder may change, its tests among them, and no more than the change needs: a path from the top of the repository, a folder ending in \`/\`, or a pattern with \`*\`. It takes in ${FLAG_NAMES_FILE}, the app’s typed list of the flags it asks about, where the coder adds the flag’s name.`,
  CONTRADICTS_RULE,
  `- \`risks\`: a list of tags, each exactly one of these words, for what the change itself does; usually it is empty. ${RISKS.map((r) => `${r}: ${IMPROVEMENT_RISK_MEANINGS[r]}`).join('; ')}.`,
  '- `rollout`: a sentence or two on what Martin should look for on the pages as he turns the flag on.',
  `Every string is a plain sentence or a path, at most ${PATH_CHARS} characters (the rollout 300).`,
];

/**
 * An improvement's plan: Martin's words, to where the change goes in the app and a spec behind a flag of its own. Not
 * a diagnosis, since nothing is wrong, and nothing built or tried: the coder builds it, test first.
 */
function requestPrompt(input: PlannerInput, request: Request): string {
  const { workItem, protectedPaths, answers, failure, flagsTaken = [], lastSpec } = input;
  const asks = asksMartin(input);
  return [
    `Plan improvement #${workItem}: ${request.title}.`,
    `Martin asked for it in his own words: “${request.words}”`,
    ...answerLines(answers),
    ...replanLines(input),
    ...(failure ? ['', `Your last attempt at this plan failed: ${failure}. Do not hand back the same again.`] : []),
    '',
    'Nothing is broken: this is a change Martin wants. Find where it goes in the repository: start from the pages it shows on, and read the code that serves them and its tests. Stop as soon as you can say which code changes and what a visitor will see: that is all the plan needs, and most plans need a dozen tool calls or fewer.',
    'Do not build it or try it: start no server, send no requests, write no scripts, and run no tests. The coder builds it, test first, and your criteria say what those tests show. You plan; the coder builds. Change nothing: no change of yours leaves this checkout.',
    '',
    `The change ships behind a feature flag of its own, off. The app asks whether a flag is on with \`await request.flag('name')\`, as AGENTS.md says, with a name on its typed list of flag names, ${FLAG_NAMES_FILE}; and a flag the flag service does not name is off: so the change reaches nobody until Martin turns its flag on, a stage at a time. With the flag off, the app does exactly what it does now.`,
    '',
    'The change does what Martin asked, and no more. The app is full of other things that are wrong with it: anything you notice, or anything else it could do better, goes in `findings`, never in the spec. Triage judges each one as it judges a visitor’s report; it opens no ticket on your word alone. Leave `findings` empty when you noticed nothing else.',
    '',
    ...(!asks ? [UNANSWERED, 'Where what he asked could mean more than one thing, take the plainer reading.', ''] : []),
    `Then write the result, one of ${asks ? 'three' : 'two'}, each with its \`findings\`:`,
    '1. {"verdict":"spec","spec":{"title","outcome","flag","pages":[],"criteria":[{"given","when","expect","withFlag","from","quote"}],"scope":[],"contradicts":[],"risks":[],"rollout"},"findings":[{"page","route","text"}]}, the spec the coder will be held to, which Martin approves before any code is written:',
    ...improvementTemplate(flagsTaken, lastSpec?.flag).map((line) => `   ${line}`),
    `2. {"verdict":"reject","reason"} when the line may not make the change. Reject it when it needs a path no scope may name, the app’s flag context among them: ${protectedWords(protectedPaths).join(', ')}. Reject it when it would keep anything on a visitor’s device, such as a cookie or anything in the browser’s storage: nothing goes there that a visitor did not ask for, and what may is decided outside this repository. Reject it too when no test could tell the change from the app as it is. The reason is one or two short sentences for Martin, at most 300 characters, naming the file or what is in the way.`,
    ...(asks
      ? [
          '3. {"verdict":"question","question"} when what Martin asked could mean more than one thing, and the spec turns on which: one question he can answer in a line, at most 300 characters.',
        ]
      : []),
    `\`findings\`: at most ${MAX_PLANNER_FINDINGS}, each with \`page\`, a page of the app that shows it, as the path a visitor opens, without its query (\`/\` when it shows on none); \`route\`, the route that serves that page, as the app’s code names it, such as \`/products/:slug\`; and \`text\`, what is wrong or could be better, in a sentence or two of at most 300 characters, with the query if it shows only with one.`,
  ].join('\n');
}

export const planner = defineAgent<PlannerInput, PlannerResult>({
  agent: 'planner',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  plansFromBase: true,
  input: async ({ workItem, state, commit, failure, ticket, request, signals, read, flagsTaken, change }) => ({
    workItem,
    asked: await askedOf({ state, ticket, request }),
    signals: await signals(),
    protectedPaths: await read('protectedPaths', { ref: commit }),
    answers: state.answers,
    persisted: state.persisted,
    reopened: state.reopened.filter((r) => !r.dryRun),
    failure,
    // Martin approved its last question with no answer: none will come (`machine.ts`).
    ...(state.unanswered ? { unanswered: true } : {}),
    // Martin's words there are public only shared, so a question asks nothing of the report (`machine.ts`).
    ...(state.firstSense === 'report' ? { aboutReport: true } : {}),
    ...(state.request ? { flagsTaken: await flagsTaken() } : {}),
    ...(state.lastSpec ? { lastSpec: state.lastSpec, ...(state.shipped ? { shipped: true } : {}) } : {}),
    ...(state.replan ? { replan: state.replan } : {}),
    ...(change ? { change: { ...change, commit } } : {}),
  }),
  schema: (input) =>
    plannerResult(
      input.protectedPaths,
      sourcesOf(input),
      input.asked.kind === 'request' ? { flagsTaken: input.flagsTaken ?? [], keeps: input.lastSpec?.flag } : undefined,
      asksMartin(input),
      input.shipped ? input.lastSpec : undefined,
    ),
  prompt: (input) =>
    input.asked.kind === 'ticket' ? ticketPrompt(input, input.asked.ticket) : requestPrompt(input, input.asked.request),
  apply: async (planned, _handback, _input, context) => {
    // A spec that names a test its file does not have is refused before it leaves anything, as one the schema refuses.
    if (planned.verdict === 'spec') await checkContradicted(planned.spec, context);
    // A finding is known by where it is and what it says, so the same one handed back by a later plan, after a
    // question or a replan, is not left again.
    for (const found of planned.findings) {
      const key = `finding ${found.route} ${found.page} ${found.text}`;
      await context.leaveSignal(key, findingSignal(found, context.workItem, context.commit));
    }
    const dropped = planned.dropped ?? [];
    // Once for the handback, though its effects are tried again after GitHub or the store fails.
    if (dropped.length) {
      await context.once('log dropped findings', async () => {
        context.log.warn({ workItem: context.workItem, dropped }, 'the planner handed back findings that do not fit');
      });
    }
    const left = [
      ...(planned.findings.length ? [`${count(planned.findings.length, 'finding')} left for triage`] : []),
      ...(dropped.length ? [`${count(dropped.length, 'finding')} that did not fit left out`] : []),
    ]
      .map((part) => `; ${part}`)
      .join('');
    switch (planned.verdict) {
      case 'spec': {
        const spec = tagged(planned.spec);
        const summary = `Spec written: ${count(spec.criteria.length, 'criterion', 'criteria')}, ${count(spec.scope.length, 'path')} in scope${left}`;
        return [{ type: 'spec.written', actor: 'planner', summary, payload: spec }];
      }
      case 'reject':
        return [
          holdDraft('planner', { stage: 'plan', kind: 'held', cause: 'ticket-rejected', reason: planned.reason }),
        ];
      case 'question':
        return [
          holdDraft('planner', {
            stage: 'plan',
            kind: 'question',
            cause: 'question',
            reason: 'The planner needs an answer to write the spec',
            question: planned.question,
          }),
        ];
    }
  },
});
