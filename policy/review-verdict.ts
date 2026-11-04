/**
 * The review gate's verdict, as its `review` check's summary carries it (`scripts/review-gate.ts`, ADR 0014): the rule
 * that decided, the risk tags the gate found in the diff with what gave each, and the head it judged. The gate writes
 * the block with `verdictBlock` and the line reads it with `readVerdict`, so the two cannot drift apart.
 *
 * The block is an HTML comment, which GitHub does not show, beside the words Needs you shows:
 *
 *     <!-- review-verdict v1
 *     {"commit":"<sha>","judged":[{"number":7,"head":"<sha>","rule":"low-risk","tags":[]}]}
 *     -->
 *
 * `commit` is the commit the check is on: a pull request's head, or the merge queue's commit for it. `judged` has one
 * entry for each pull request the verdict covers, since a check on a commit is every open pull request's whose head it
 * is, and the queue's commit for a stacked pull request carries those below it: each with the head it was judged at.
 * The check passes only when every entry's rule passes.
 *
 * Read it only from the check run named `review` that the review App (5470762) posted, for the pull request's current
 * head: the factory's App can post check runs too, and its text could say anything.
 *
 * Plain TypeScript with no imports: the gate runs it from a sparse checkout, with Node and nothing installed.
 *
 * Human-owned: see `README.md`.
 */

/** The rules the gate decides by, the first that holds; `held` when none does. */
export const RULES = ['martin-opened', 'martin-approved-head', 'exact-pin', 'low-risk', 'lights-out', 'held'] as const;
export type Rule = (typeof RULES)[number];

/** The risk tags the gate works out from a diff, never from labels. */
export const TAGS = [
  'test-loosening',
  'dependency-change',
  'security-headers',
  'code-owned',
  'release',
  'improvement',
] as const;
export type Tag = (typeof TAGS)[number];

/** The tags Lights-out never passes: a release and an improvement are Martin's in every mode, and so is his code. */
export const NEVER_LIGHTS_OUT: readonly Tag[] = ['release', 'improvement', 'code-owned'];

/**
 * The labels that carry a risk: the gate's tags, and the planner's and the reviewer's `out-of-scope`. Any of them
 * removed by anyone but Martin holds the pull request.
 */
export const RISK_LABELS: readonly string[] = [...TAGS, 'out-of-scope'];

/** A tag, with what gave it: the paths, tests or lines, at most `GIVEN_LIMIT` of them, and a count of the rest. */
export interface Found {
  tag: Tag;
  because: string[];
  more?: number;
}

/** One pull request's verdict. */
export interface Judged {
  number: number;
  /** The head commit it was judged at. */
  head: string;
  rule: Rule;
  tags: Found[];
}

export interface Verdict {
  version: 1;
  /** The commit the check is on. */
  commit: string;
  judged: Judged[];
}

/** The most things named as giving one tag: a summary has room for 65,535 characters. */
export const GIVEN_LIMIT = 20;

/** Whether a rule passes the pull request: every rule but `held`. */
export const passes = (rule: Rule): boolean => rule !== 'held';

const OPEN = '<!-- review-verdict v1\n';
const CLOSE = '\n-->';
const SHA = /^[0-9a-f]{40}$/;

/** A tag with what gave it, cut to `GIVEN_LIMIT`. */
export function found(tag: Tag, because: readonly string[]): Found {
  const kept = [...new Set(because)];
  const more = kept.length - GIVEN_LIMIT;
  return more > 0 ? { tag, because: kept.slice(0, GIVEN_LIMIT), more } : { tag, because: kept };
}

/**
 * The block for a summary. `<` and `>` are written as their JSON escapes, so nothing in a path or a test's name can
 * end the comment early or open a second block.
 */
export function verdictBlock(verdict: Verdict): string {
  const json = JSON.stringify({ commit: verdict.commit, judged: verdict.judged })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
  return `${OPEN}${json}${CLOSE}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readFound(value: unknown): Found | string {
  if (!isObject(value)) return 'a tag is not an object';
  const { tag, because, more } = value;
  if (!TAGS.includes(tag as Tag)) return `${JSON.stringify(tag)} is not a tag`;
  if (!Array.isArray(because) || !because.every((b) => typeof b === 'string'))
    return `what gave ${String(tag)} is not a list of strings`;
  if (more !== undefined && !(Number.isInteger(more) && (more as number) > 0))
    return `the count of the rest of ${String(tag)} is not a positive integer`;
  return more === undefined ? { tag: tag as Tag, because } : { tag: tag as Tag, because, more: more as number };
}

function readJudged(value: unknown): Judged | string {
  if (!isObject(value)) return 'a verdict is not an object';
  const { number, head, rule, tags } = value;
  if (!(Number.isInteger(number) && (number as number) > 0)) return 'a verdict names no pull request';
  if (typeof head !== 'string' || !SHA.test(head)) return `#${number}'s head is not a commit`;
  if (!RULES.includes(rule as Rule)) return `#${number}'s rule, ${JSON.stringify(rule)}, is not a rule`;
  if (!Array.isArray(tags)) return `#${number}'s tags are not a list`;
  const read: Found[] = [];
  for (const tag of tags) {
    const each = readFound(tag);
    if (typeof each === 'string') return `#${number}: ${each}`;
    read.push(each);
  }
  return { number: number as number, head, rule: rule as Rule, tags: read };
}

/**
 * The verdict a summary carries, or why it carries none: no block, more than one, or one that does not parse whole.
 * Nothing is guessed: a block with anything wrong in it is no verdict.
 */
export function readVerdict(summary: string | null | undefined): Verdict | { error: string } {
  const text = summary ?? '';
  const start = text.indexOf(OPEN);
  if (start === -1) return { error: 'the summary carries no verdict' };
  if (text.indexOf(OPEN, start + OPEN.length) !== -1) return { error: 'the summary carries more than one verdict' };
  const end = text.indexOf(CLOSE, start + OPEN.length);
  if (end === -1) return { error: "the summary's verdict does not end" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start + OPEN.length, end));
  } catch {
    return { error: "the summary's verdict is not JSON" };
  }
  if (!isObject(parsed)) return { error: "the summary's verdict is not an object" };
  const { commit, judged } = parsed;
  if (typeof commit !== 'string' || !SHA.test(commit)) return { error: "the verdict's commit is not a commit" };
  if (!Array.isArray(judged) || judged.length === 0) return { error: 'the verdict judges no pull request' };
  const read: Judged[] = [];
  for (const each of judged) {
    const one = readJudged(each);
    if (typeof one === 'string') return { error: one };
    read.push(one);
  }
  return { version: 1, commit, judged: read };
}

/** Whether the whole verdict passes: every pull request it judged, by a rule that passes. */
export const verdictPasses = (verdict: Verdict): boolean => verdict.judged.every((each) => passes(each.rule));
