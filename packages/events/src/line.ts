/**
 * What the line decides by and the console draws with: the bounds on a work item's loop, what each answer to a hold
 * does, how a spec's scope matches a path and another spec's scope, when two versions are the same, which of a canary's
 * measurements is which, and a return's few words. One copy, here, because the console's image holds the events package and not the factory's code, and two
 * copies of a rule drift apart. Plain values, so the browser can import them.
 */
import { cutTo } from './text.ts';
import type { PayloadOf } from './types.ts';
import type { HoldAnswer, HoldCause, Stage } from './vocabulary.ts';

/** How far the line lets a work item go round before it holds for Martin. */
export const LIMITS = {
  /** Reviews a work item has: blocking findings after the last of them hold it (the decisions: two rounds). */
  reviews: 2,
  /** Times failing gates send the coder back before the work item holds. */
  gateReturns: 2,
  /** Failed attempts at one step (no handback, no result, a result its schema refuses) before it holds. */
  failures: 2,
  /** Tries at a handback's effects, when GitHub or the store fails, before the work item holds. */
  effects: 6,
  /**
   * Patches the scope fence refuses before the work item holds: the first goes back to the coder with the fence's
   * output, and the second holds. Martin's answer to the hold starts the count again.
   */
  fenceRefusals: 2,
  /**
   * Verifications after a release that find the ticket's signal persisting before the work item holds: the first
   * sends the work back to Plan, with the verification, and the second holds for Martin.
   */
  persists: 2,
  /**
   * Rounds the suggestions of an approving review send the coder back for, in a pass, to take or decline them before
   * the reviewer looks again. The review after that round goes on, whatever it suggests.
   */
  suggestions: 1,
} as const;

/**
 * Triage's causes of a hold, which an answer in words leaves standing: triage acts only on Martin's approval or
 * rejection of what they hold, so his words settle nothing, and the work item stays held, and Needs you lists it,
 * until he gives one. The line's `ANSWERS` has each wait for an answer in words.
 */
export const WORDS_LEAVE_HELD: readonly HoldCause[] = ['suggestion', 'finding', 'burst', 'environment'];

/** What Martin's answer to a hold does to the work item. */
export type Resolution =
  /** It carries on from where it was held: the step it was held at runs again, with his answer. */
  | 'carry-on'
  /** The planner writes the spec again, with his answer. */
  | 'replan'
  /** His approval stands in for the reviewer's, and the change goes on to its description and his merge. */
  | 'approve'
  /** The work goes back to the coder, with his answer as the reason. */
  | 'return'
  /** Nothing for the line to do: it waits for him, as for his merge. */
  | 'wait'
  /** He judges the fix verified in production, and the work item closes as verified. */
  | 'verified'
  /** The work item closes unmerged. */
  | 'close';

/**
 * What each answer does, for each cause of a hold: the line acts by it, and Needs you says it beside each answer.
 * Rejecting closes the work item, whatever the cause. Where the planner rejected the ticket, approving agrees with it
 * and closes the work item too; only an answer, which tells the planner what it missed, sends the ticket back to it.
 * Where the fence kept refusing the coder's patch, approving says the coder needed those files and answering says what
 * to do instead: either way the planner writes the spec again, told both. Where the coder's first round found nothing
 * to fix, approving agrees with it and closes the work item; answering sends the spec back to the planner, told what
 * the coder said and what Martin did.
 */
export const ANSWERS: Record<HoldCause, Record<HoldAnswer, Resolution>> = {
  // Triage's: a suggestion never comes onto the line, nor does a defect only the planner has seen until Martin approves
  // it, nor a burst's problems, or those seen while what their sense reads was not healthy, until he lets them through.
  // Triage then opens their tickets, and the line carries each on from there as any other. Triage closes a suggestion
  // he rejects. A suggestion never starts work, so approving one does nothing: Martin, having read one, asks for the
  // improvement himself with the console's "+", in his own words (spec 5.3: a report only ever leads to a defect fix).
  suggestion: { approved: 'wait', rejected: 'close', answered: 'wait' },
  finding: { approved: 'carry-on', rejected: 'close', answered: 'wait' },
  burst: { approved: 'carry-on', rejected: 'close', answered: 'wait' },
  environment: { approved: 'carry-on', rejected: 'close', answered: 'wait' },
  spec: { approved: 'carry-on', rejected: 'close', answered: 'replan' },
  question: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  'ticket-rejected': { approved: 'close', rejected: 'close', answered: 'carry-on' },
  scope: { approved: 'replan', rejected: 'close', answered: 'replan' },
  'nothing-to-fix': { approved: 'close', rejected: 'close', answered: 'replan' },
  failures: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  gates: { approved: 'return', rejected: 'close', answered: 'return' },
  review: { approved: 'approve', rejected: 'close', answered: 'return' },
  'beyond-ticket': { approved: 'approve', rejected: 'close', answered: 'replan' },
  // Martin merges on GitHub, which answers the hold; his words send the work back to the coder.
  merge: { approved: 'wait', rejected: 'close', answered: 'return' },
  // A deploy is merged by Martin, not answered: a release that carries the change ends the hold by itself.
  deploy: { approved: 'wait', rejected: 'close', answered: 'wait' },
  // A canary paused for Martin is answered from the Canary panel, by promoting it fully or aborting it: the release
  // that ends ends the hold. No answer of the holds' does anything.
  canary: { approved: 'wait', rejected: 'wait', answered: 'wait' },
  // At Verify, when no sense can tell or the signal persisted again: approving says the fix is verified, and answering
  // sends the work back to the planner with what he said.
  verify: { approved: 'verified', rejected: 'close', answered: 'replan' },
  // The cap is Martin's, within policy: approving carries on, and the line holds again until the cap is raised. Raising
  // the work item's cap past what it has spent approves it (the admin service, `admin/settings.ts`).
  spend: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  // The line makes no such hold yet: approving accepts the tests as they are, answering says what to test.
  'tests-first': { approved: 'carry-on', rejected: 'close', answered: 'return' },
  unknown: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
};

/**
 * The answers a hold of this cause takes from the console, in the order Needs you shows them: each that does
 * something. An answer the line would only wait after is left off (a fix waiting for Martin's deploy takes only his
 * rejection), but for words on one of triage's holds, which are kept with it while it stays held.
 */
export const answersTo = (cause: HoldCause): HoldAnswer[] =>
  (['approved', 'answered', 'rejected'] as const).filter(
    (answer) => ANSWERS[cause][answer] !== 'wait' || (answer === 'answered' && WORDS_LEAVE_HELD.includes(cause)),
  );

/**
 * The longest path an event records, in characters: a file a patch changes, a scope entry, a review finding's file. A
 * patch that names a longer path is refused (`plainPath`), so a path the events could not record never reaches the
 * scope fence, GitHub or the console from the coder, and `pattern` steps through no longer one from a patch. One
 * another push put on a pull request's branch is cut to fit where a push records the whole change, and marked.
 */
export const PATH_CHARS = 200;

/**
 * A page of the app, by its path alone: one slash and no second, and no query, fragment, scheme, backslash or space, so
 * it names a page of the app and nothing else, and a link made of it stays on the app's own origin (`//` would name
 * another host). The spec's pages are held to it, and the console holds a preview link to it again.
 */
export const PAGE_PATH = /^\/(?!\/)[^\s?#:\\]*$/;

/**
 * A scope entry as a pattern: a file (`src/money.ts`), a folder ending in `/` (`test/`), or a pattern with `*` (one
 * path segment, or part of one) or `**` (as a segment of its own, any number of whole segments: `**` followed by `/`
 * stands for none or some folders, so `**` followed by `/test.ts` is `test.ts` in any folder, never `latest.ts`; within
 * a segment it is any text, slashes too). `*` takes in any character but `/`, and `**` any at all: a line or paragraph
 * separator in a path is a character like any other, so none can slip it past a folder or a `**`.
 *
 * It tests a path by stepping it through the entry's automaton (`automatonOf`) a character at a time, keeping every
 * state the characters so far could have reached: at most the path's length times the entry's steps, whatever the
 * entry. A backtracking regular expression would try every way of splitting a near miss between the `*`s, which grows
 * exponentially with them: the planner writes scopes from strangers' reports, and must not be able to stall the fence.
 * The last few hundred entries' automata are kept, as a scope is tested against each path of a patch in turn.
 */
export function pattern(entry: string): { test: (path: string) => boolean } {
  let automaton = kept.get(entry);
  if (!automaton) {
    if (kept.size >= KEPT) kept.clear();
    automaton = automatonOf(entry);
    kept.set(entry, automaton);
  }
  const made = automaton;
  return { test: (path) => takesIn(made, path) };
}

/** The automata `pattern` has made, by entry: no more than `KEPT`, so a long-running line holds no more. */
const kept = new Map<string, Automaton>();
const KEPT = 512;

/** A scope entry's parts: `**` followed by `/` as a segment of its own, `**` and `*` anywhere else, and the text between. */
// `**` followed by `/` stands for folders only as a segment of its own: in `a**/b` it is any text, then the slash.
const partsOf = (entry: string) => entry.split(/((?<=^|\/)\*\*\/|\*\*|\*)/).filter((part) => part !== '');

/** Whether any entry of a scope matches a path: the scope fence's rule, and the GitHub worker's. */
export const inScope = (path: string, scope: readonly string[]) => scope.some((entry) => pattern(entry).test(path));

/**
 * A path as an event records it where it may name a file the coder did not write: a pull request's whole change, as
 * GitHub compares its head with main, names every file the branch changes, one pushed by hand included. One longer
 * than `PATH_CHARS` is cut to fit, ending in `…`, and marked `cut` (`knownInScope`). It is cut between characters,
 * never inside one, which the store would refuse.
 */
export function recordedPath(path: string): { path: string; cut?: true } {
  return path.length <= PATH_CHARS ? { path } : { path: cutTo(path, PATH_CHARS), cut: true };
}

/**
 * Whether a path `recordedPath` gave is known to be in a scope. A cut one is only when a folder entry with no `*`
 * holds what was kept of it: whether a file entry or a pattern matches could turn on what was cut off.
 */
export function knownInScope(file: { path: string; cut?: true | undefined }, scope: readonly string[]): boolean {
  if (!file.cut) return inScope(file.path, scope);
  const kept = file.path.slice(0, -1);
  return scope.some((entry) => entry.endsWith('/') && !entry.includes('*') && kept.startsWith(entry));
}

/**
 * One move of a scope entry's automaton, to state `to`: it reads one character (a string of one), any character but
 * `/` (`segment`), any character (`any`), or none (`null`).
 */
interface Move {
  reads: string | null;
  to: number;
}

/** A scope entry as a small automaton: the moves from each state, and the state it ends at. */
interface Automaton {
  moves: Move[][];
  end: number;
}

/**
 * A scope entry as a small automaton that reads a path a character at a time, ending at `end` on each path the entry
 * takes in (`pattern` tests a path on it): a state per character of text, a loop for `*` and `**`, and for `**`
 * followed by `/` a way past it and a way through any folders, or, read `asText`, a loop for any text. Plain text
 * (`literal`) is a state per character alone.
 */
function automatonOf(entry: string, read: 'pattern' | 'asText' | 'literal' = 'pattern'): Automaton {
  const moves: Move[][] = [[]];
  const state = () => moves.push([]) - 1;
  const move = (from: number, reads: string | null, to: number) => moves[from]?.push({ reads, to });
  let at = 0;
  for (const part of read === 'literal' ? [entry] : partsOf(entry)) {
    if (part === '**/' && read === 'asText') move(at, 'any', at);
    else if (part === '**/') {
      const folders = state();
      const next = state();
      move(at, null, next);
      move(at, null, folders);
      move(folders, 'any', folders);
      move(folders, '/', next);
      at = next;
    } else if (part === '**') move(at, 'any', at);
    else if (part === '*') move(at, 'segment', at);
    else {
      // A character at a time as JavaScript strings hold them: UTF-16 code units, as `takesIn` reads a path.
      for (let i = 0; i < part.length; i++) {
        const next = state();
        move(at, part.charAt(i), next);
        at = next;
      }
    }
  }
  if (entry.endsWith('/') && read !== 'literal') move(at, 'any', at);
  return { moves, end: at };
}

/** Whether a move reads a character. */
const reads = (move: string, char: string) => move === 'any' || (move === 'segment' ? char !== '/' : move === char);

/**
 * Whether an automaton ends on a path: the set of states it could be in, stepped a character at a time, each state
 * taken once a step with every state its moves that read nothing reach. It stops as soon as no state is left.
 */
function takesIn({ moves, end }: Automaton, path: string): boolean {
  // The step at which each state was last taken, so a state joins a step's set once.
  const taken = new Int32Array(moves.length).fill(-1);
  let states: number[] = [];
  const stack: number[] = [];
  const take = (into: number[], state: number, step: number) => {
    stack.push(state);
    for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
      if (taken[at] === step) continue;
      taken[at] = step;
      into.push(at);
      for (const { reads: r, to } of moves[at] ?? []) if (r === null) stack.push(to);
    }
  };
  take(states, 0, 0);
  for (let i = 0; i < path.length; i++) {
    // A character at a time as JavaScript strings hold them, as the automaton was made.
    const char = path.charAt(i);
    const next: number[] = [];
    for (const state of states) {
      for (const { reads: r, to } of moves[state] ?? []) if (r !== null && reads(r, char)) take(next, to, i + 1);
    }
    if (!next.length) return false;
    states = next;
  }
  return taken[end] === path.length;
}

/**
 * A path two automata both end on, if there is one: they run side by side, a pair of states at a time, breadth first,
 * until both end at once or every pair they can reach together has been tried. Each pair is visited once, and keeps the
 * pair it was reached from and the character read on the way, so the path is put together only when one is found.
 */
function meet(x: Automaton, y: Automaton): string | undefined {
  const width = y.moves.length;
  const pairs = x.moves.length * width;
  const before = new Int32Array(pairs).fill(-1);
  const read: string[] = [];
  const queue = new Int32Array(pairs);
  let tail = 0;
  const visit = (pair: number, from: number, char: string) => {
    if (pair === 0 || before[pair] !== -1) return;
    before[pair] = from;
    read[pair] = char;
    queue[tail++] = pair;
  };
  queue[tail++] = 0;
  for (let head = 0; head < tail; head++) {
    const pair = queue[head] ?? 0;
    const p = Math.floor(pair / width);
    const q = pair % width;
    if (p === x.end && q === y.end) {
      let path = '';
      for (let at = pair; at !== 0; at = before[at] ?? 0) path = `${read[at] ?? ''}${path}`;
      return path;
    }
    const xs = x.moves[p] ?? [];
    const ys = y.moves[q] ?? [];
    for (const m of xs) if (m.reads === null) visit(m.to * width + q, pair, '');
    for (const n of ys) if (n.reads === null) visit(p * width + n.to, pair, '');
    for (const { reads: r, to } of xs) {
      if (r === null) continue;
      for (const { reads: s, to: other } of ys) {
        if (s === null) continue;
        // A character both read: one either names, or any but `/` when both read a class of them.
        const char = [r, s, 'x'].find((c) => c.length === 1 && reads(r, c) && reads(s, c));
        if (char !== undefined) visit(to * width + other, pair, char);
      }
    }
  }
  return undefined;
}

/**
 * A path two scope entries both take in, if there is one, found by running their automata together. Exact, not a
 * sample: it finds a path whenever `inScope` takes one in for both entries, and the path it finds is one.
 */
export const sharedPath = (a: string, b: string) => meet(automatonOf(a), automatonOf(b));

/** A path as it stands at the top: a pattern that matches anywhere (one under any folder) without its leading `**`. */
const atTop = (path: string) => path.replace(/^\*\*\//, '');

/**
 * Whether an entry touches a path by name, beyond the files they share: the entry, as text, matches the path read
 * with `**` followed by `/` as any text, folders or none; or the entry is or matches a folder's name without its slash.
 */
const byName = (entry: string, path: string, automaton = automata()) =>
  meet(automaton(entry, 'literal'), automaton(path, 'asText')) !== undefined ||
  (path.endsWith('/') && meet(automaton(entry), automaton(atTop(path).slice(0, -1))) !== undefined);

/** A maker of automata that makes each entry's, read each way, once. */
function automata() {
  const made = new Map<string, Automaton>();
  return (entry: string, read: Parameters<typeof automatonOf>[1] = 'pattern') => {
    const key = `${read}:${entry}`;
    const automaton = made.get(key) ?? automatonOf(entry, read);
    made.set(key, automaton);
    return automaton;
  };
}

/**
 * Whether a scope entry takes in any of the paths, which may be folders or patterns too: shares a file with one
 * (`sharedPath`), or touches it by name. A folder is held to a pattern that matches anywhere only at the top, so
 * `src/`, which could hold an `AGENTS.md`, does not touch `**` + `/AGENTS.md`: the scope fence refuses that file if a
 * patch changes it. A file or pattern is held to every path the pattern takes in, so `src/*.md` touches it. The planner
 * keeps its scope out of the protected paths by it.
 *
 * It errs towards sharing: by name, `docs/LATEST-AGENTS.md` touches `**` + `/AGENTS.md` too.
 */
export const touches = (entry: string, paths: readonly string[]) =>
  paths.some(
    (path) => byName(entry, path) || sharedPath(entry, entry.endsWith('/') ? atTop(path) : path) !== undefined,
  );

/**
 * The entries of one scope that may share a file with another's: each that shares a path with one of the other's
 * (`sharedPath`), or touches one by name, or is touched by one, which only adds to what is shared. The line keeps two
 * specs whose scopes overlap from running at once: a false overlap only makes one wait. Each entry's automata are
 * made once.
 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): string[] {
  const automaton = automata();
  return a.filter((entry) =>
    b.some(
      (other) =>
        byName(entry, other, automaton) ||
        byName(other, entry, automaton) ||
        meet(automaton(entry), automaton(other)) !== undefined,
    ),
  );
}

/** Work items in words: "work item #1033", "work items #1033 and #1040", or `none` for none. */
export function workItemsWords(items: readonly string[], none: string): string {
  const named = items.map((n) => `#${n}`);
  if (!named.length) return none;
  const listed = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  return `work item${named.length > 1 ? 's' : ''} ${listed}`;
}

/**
 * The release a look again found a work item's signal cleared on, in words: the fixes of the releases since its signal
 * was last seen, each with its pull request, and, for a held or waiting work item, that none was this one's. The line's
 * comments and closes, and the console, say it the same way. Only when those releases carried no work item does it
 * say they carried none of the factory's fixes. A version 1 look named the release looked at's alone, with no `since`.
 */
export function clearedOnWords(
  look: Pick<PayloadOf<'signal.rechecked'>, 'for' | 'carried' | 'since' | 'merged'>,
): string {
  const { carried, since } = look;
  const own = look.for === 'release' || look.for === 'wait' ? ', not this one’s' : '';
  if (since === undefined) {
    return carried.length
      ? `a release that carried ${workItemsWords(carried, '')}${own ? `${own} fix` : ''}`
      : 'a release that carried none of the factory’s fixes';
  }
  const after = `a version released since ${shortCommit(since)}, where its signal was last seen`;
  if (!carried.length) return `${after}, with none of the factory’s fixes`;
  const pulls = new Map((look.merged ?? []).map((m) => [m.workItem, m.pullRequest]));
  const named = carried.map((n) => (pulls.has(n) ? `#${n} (pull request #${pulls.get(n)})` : `#${n}`));
  const listed = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  const fixes = named.length > 1 ? 'the fixes of work items' : 'the fix of work item';
  return `${after}, with ${fixes} ${listed}${own}`;
}

/** A commit shortened as the line writes it, or any other version as it is. */
const shortCommit = (version: string) => (/^[0-9a-f]{8,40}$/.test(version) ? version.slice(0, 7) : version);

/** The same version of the app, whether either names its commit in full or shortened. */
export const sameVersion = (a: string, b: string) =>
  a === b || (/^[0-9a-f]{7,40}$/.test(a) && /^[0-9a-f]{7,40}$/.test(b) && (a.startsWith(b) || b.startsWith(a)));

/**
 * A measurement of a canary's background analysis, by its measure and when it ended: the line records each once, in a
 * `canary.measuring`, and the console counts each once, whichever look or work item it arrives on. Argo Rollouts keeps
 * the end to the second, so two measurements of one measure that ended in the same second would be one; a measure's
 * interval, a minute or more, keeps them apart.
 */
export const measurementOf = (m: { name: string; at: string }) => `${m.name}@${Date.parse(m.at)}`;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why work went back to Build, in a few words, from what its `work.returned` records: "2 blocking", "1 check failed",
 * "2 suggestions". The line writes them in the event's summary and the console draws them, so both say the same.
 */
export function returnWords(returned: {
  from: Stage;
  blocking?: number | undefined;
  suggestions?: number | undefined;
  failed?: readonly string[] | undefined;
}): string {
  if (returned.blocking !== undefined) return `${returned.blocking} blocking`;
  if (returned.suggestions !== undefined) return count(returned.suggestions, 'suggestion');
  // The gates hold a run with no failed check named as failed all the same: one check, unnamed.
  if (returned.failed !== undefined) return `${count(returned.failed.length || 1, 'check')} failed`;
  return `sent back from ${returned.from}`;
}
