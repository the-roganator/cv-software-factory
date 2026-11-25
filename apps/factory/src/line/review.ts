/**
 * A review as GitHub shows it: a comment review, with each finding anchored to its line, and a check run beside it.
 * Both are signals, never gates: the review only comments, so it never counts toward a merge, and the check run is
 * one no ruleset requires, which the line leaves out of the gates it reads (`gates.ts`).
 *
 * GitHub refuses a whole review if one comment is anchored to a line the pull request's diff does not show, so each
 * finding is checked against the diff first. One anchored elsewhere is not lost: it goes in the review's body, with
 * where the reviewer put it.
 *
 * A finding's thread is answered and resolved once the finding is: a blocking finding or a suggestion a later review
 * finds put right, with the commit it reviewed, and a suggestion the coder declines, with its reason; and every
 * finding still open of a held review Martin approves in the console, saying he accepted it. So is the thread of every
 * earlier finding it held again (`lineage`). The app's `main` merges nothing with a review thread open. The
 * thread is found by its comment, as this module wrote it, and the line it was made on.
 */
import type { PayloadOf } from '@software-factory/events';
import type { CheckRunReport, ReviewComment, ThreadAnswer } from '../github/actions.ts';
import type { Comparison } from '../github/reads.ts';
import { GitHubWorkerError } from '../github/worker-client.ts';
import type { EffectsContext } from './agents/agent.ts';
import type { ReviewerResult } from './agents/reviewer.ts';

/** A review as GitHub is given it: its verdict, its note and its findings, each citing the ticket or not. */
type Review = Pick<ReviewerResult, 'verdict' | 'note'> & { findings: Finding[] };

export type Finding = PayloadOf<'review.submitted'>['findings'][number];

/** What a finding cites, as a reader sees it: "rule 4 · criterion 2", or "the ticket". */
export const cites = (f: Pick<Shown, 'rule' | 'criterion' | 'ticket'>) =>
  [f.ticket && 'the ticket', f.rule && `rule ${f.rule}`, f.criterion && `criterion ${f.criterion}`]
    .filter(Boolean)
    .join(' · ');

/** The factory's check run, by name. */
export const REVIEW_CHECK = 'factory review';

/**
 * For each file a comparison changes, the lines of its new version the diff shows (added, or kept around a change):
 * the lines a review comment can be anchored to.
 */
export function shownLines(files: Comparison['files']): Map<string, Set<number>> {
  const shown = new Map<string, Set<number>>();
  for (const { path, patch } of files) {
    const lines = new Set<number>();
    let line = 0;
    for (const text of (patch ?? '').split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) line = Number(hunk[1]);
      else if (line && (text.startsWith('+') || text.startsWith(' '))) lines.add(line++);
    }
    shown.set(path, lines);
  }
  return shown;
}

export interface ReviewInGitHub {
  body: string;
  comments: ReviewComment[];
  check: CheckRunReport;
}

/** A finding as a reader is shown it, whether its `ticket` is the events' `true` or a result's yes or no. */
type Shown = Omit<Finding, 'ticket'> & { ticket?: boolean | undefined };

const mark = (f: Shown) => `**${f.blocking ? 'Blocking' : 'Suggestion'}**${cites(f) ? ` · ${cites(f)}` : ''}`;

/** A finding as the review's body and the check run's summary list it: one line, after its place and its mark. */
export const listed = (f: Shown) => `- \`${f.path}:${f.line}\`: ${mark(f)}: ${f.comment}`;

/** A finding as its comment on the pull request reads, which is how its thread is found again. */
export const commentOf = (f: Finding): ReviewComment => ({
  path: f.path,
  line: f.line,
  body: `${mark(f)}\n\n${f.comment}`,
});

/**
 * The threads to answer, each a finding's with what to reply on it, less any a later review gives again word for word
 * on the same line, whose thread would be its own new one.
 */
export function threadAnswers(answers: { finding: Finding; reply: string }[], held: Finding[] = []): ThreadAnswer[] {
  const key = (c: ReviewComment) => `${c.path}:${c.line}\n${c.body}`;
  const again = new Set(held.map((f) => key(commentOf(f))));
  return answers.map(({ finding, reply }) => ({ ...commentOf(finding), reply })).filter((c) => !again.has(key(c)));
}

/**
 * A finding of the latest review, and every earlier finding it holds again (`holds`), back to the first: a finding
 * held again in new words has a thread of its own, and each of them is answered when the last is.
 */
export function lineage(reviews: readonly PayloadOf<'review.submitted'>[], finding: Finding): Finding[] {
  const found = [finding];
  let held = finding;
  for (let r = reviews.length - 1; held.holds !== undefined && r > 0; r--) {
    const before = reviews[r - 1]?.findings[held.holds - 1];
    if (!before) break;
    found.push(before);
    held = before;
  }
  return found;
}

/**
 * The threads Martin's approval of a held review answers, which stands in for the reviewer's: each finding it blocked
 * on and each suggestion it sends on with no round (`acceptedFindings`), and each earlier finding one holds again,
 * with what the line says on them, as of when he answered, so a reply asked for again reads the same and is made
 * once. His words are said with it, unless they stay his, on a work item a visitor's report opened.
 */
export function acceptedThreads(
  reviews: readonly PayloadOf<'review.submitted'>[],
  { blocking, suggestions }: { blocking: Finding[]; suggestions: Finding[] },
  at: Date,
  words: string | undefined,
): ThreadAnswer[] {
  const when = `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const said = words ? `\n\nHe said: “${words}”` : '';
  const accepted = `Martin accepted this in the console at ${when}, in place of the factory’s reviewer’s approval.${said}`;
  const unasked = `Martin approved the change in the console at ${when}, in place of the factory’s reviewer’s approval, with no round for its suggestions: this one is not taken.${said}`;
  // Each thread by what it was: an earlier finding that blocked, held again as a suggestion, was accepted all the same.
  const answers = (findings: Finding[]) =>
    findings.flatMap((finding) =>
      lineage(reviews, finding).map((f) => ({ finding: f, reply: f.blocking ? accepted : unasked })),
    );
  return threadAnswers([...answers(blocking), ...answers(suggestions)]);
}

/**
 * The suggestions among a review's findings the coder has not declined, in order: a suggestion is numbered among the
 * findings that do not block, from 1, as the coder was given them and `suggestions.answered` names them.
 */
export function suggestionsLeft(
  findings: readonly Finding[],
  answered: PayloadOf<'suggestions.answered'> | undefined,
): Finding[] {
  const declined = new Set(answered?.declined.map((d) => d.suggestion));
  return findings.filter((f) => !f.blocking).filter((_, i) => !declined.has(i + 1));
}

/** What the GitHub worker says of a request that asking again will not help: refused, gone, or not as it was. */
const REFUSED = [403, 404, 409, 422];

/**
 * Replies on each thread and resolves it, once for the handback under `name`. It tidies up after a review already
 * posted or a change already pushed, so GitHub refusing it does not hold the work item, and Martin resolves by hand
 * what is left. GitHub failing is tried again, with the handback.
 */
export async function answerThreads(
  context: EffectsContext,
  name: string,
  pullRequest: number,
  threads: ThreadAnswer[],
): Promise<void> {
  await resolveThreads(threads, (batch, i) =>
    context.once(i ? `${name} ${i + 1}` : name, () =>
      context.act('resolveThreads', { number: pullRequest, threads: batch }),
    ),
  );
}

/**
 * Has each thread answered and resolved, once each, in as many calls as the GitHub worker needs (`resolve`, given
 * each batch and its place). GitHub refusing it holds nothing up: what is left is Martin's to resolve by hand, and it
 * gives back false. The GitHub worker replies on a thread only once and passes over one resolved, so asking again
 * after a failure is safe.
 */
export async function resolveThreads(
  threads: ThreadAnswer[],
  resolve: (batch: ThreadAnswer[], index: number) => Promise<unknown>,
): Promise<boolean> {
  let done = true;
  const key = (c: ReviewComment) => `${c.path}:${c.line}\n${c.body}`;
  const once = threads.filter((t, i) => threads.findIndex((u) => key(u) === key(t)) === i);
  // The worker takes at most fifty threads a call: a finding held again through every review answers one each.
  for (let i = 0; i < once.length; i += THREADS_A_CALL) {
    await resolve(once.slice(i, i + THREADS_A_CALL), i / THREADS_A_CALL).catch((error: unknown) => {
      if (!(error instanceof GitHubWorkerError && REFUSED.includes(error.status))) throw error;
      done = false;
    });
  }
  return done;
}

/** The most threads the GitHub worker resolves in one call. */
const THREADS_A_CALL = 50;

const CONCLUSIONS: Record<ReviewerResult['verdict'], NonNullable<CheckRunReport['conclusion']>> = {
  approved: 'success',
  'changes-requested': 'failure',
  escalated: 'neutral',
};

const TITLES: Record<ReviewerResult['verdict'], (blocking: number) => string> = {
  approved: () => 'Approved',
  'changes-requested': (n) => `Changes requested: ${n} blocking ${n === 1 ? 'finding' : 'findings'}`,
  escalated: () => 'Escalated to Martin',
};

/** What becomes of a review, as its body ends by saying. */
function after({ verdict, findings }: Review, last: boolean, suggestionsBack: boolean): string {
  const suggests = findings.some((f) => !f.blocking);
  if (verdict === 'approved') {
    if (!suggests) return 'the change goes on to its description and Martin’s merge';
    return suggestionsBack
      ? 'its suggestions go back to the coder to take or decline, and then the change goes on to its description and Martin’s merge'
      : 'the change goes on to its description and Martin’s merge, and its suggestions stay for him';
  }
  if (verdict === 'escalated') return 'it is escalated, and Martin decides';
  if (last) return 'this was the last review the line allows, so Martin decides';
  return suggests
    ? 'the blocking findings go back to the coder, with the suggestions to take or decline'
    : 'the blocking findings go back to the coder';
}

/**
 * The review and check run a reviewer's result makes on the commit it reviewed, given the pull request's diff.
 * `review` counts the pull request's reviews, this one included, `last` says it is the last the line allows, and
 * `suggestionsBack` that an approval's suggestions would send the work back to the coder (`suggestionsGoBack`).
 */
export function reviewInGitHub(
  review: Review,
  files: Comparison['files'],
  {
    commit,
    workItem,
    review: number,
    last,
    suggestionsBack = false,
  }: { commit: string; workItem: string; review: number; last: boolean; suggestionsBack?: boolean },
): ReviewInGitHub {
  const shown = shownLines(files);
  const anchored = review.findings.filter((f) => shown.get(f.path)?.has(f.line));
  const elsewhere = review.findings.filter((f) => !anchored.includes(f));
  const blocking = review.findings.filter((f) => f.blocking).length;
  const body = [
    review.note,
    ...(elsewhere.length ? ['', 'Not on a line the diff shows:', '', ...elsewhere.map(listed)] : []),
    '',
    `_The factory’s reviewer, review ${number}. A signal, never a gate: ${after(review, last, suggestionsBack)}._`,
  ].join('\n');
  return {
    body,
    comments: anchored.map(commentOf),
    check: {
      name: REVIEW_CHECK,
      headSha: commit,
      status: 'completed',
      conclusion: CONCLUSIONS[review.verdict],
      title: TITLES[review.verdict](blocking),
      summary: [review.note, ...(review.findings.length ? ['', ...review.findings.map(listed)] : [])].join('\n'),
      externalId: workItem,
    },
  };
}
