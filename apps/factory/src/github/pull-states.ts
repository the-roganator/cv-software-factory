/**
 * The state of every pull request and issue that carries one of the scan's moves, as the GitHub worker last saw it, for
 * the dependency sense (`patching.read`'s `pulls`, served on the patching door as the read `pulls`): the App's pin pull
 * requests and issues, and Dependabot's pull requests for a pin the day lists.
 *
 * Nothing here asks GitHub for anything of its own accord: the watches that decide write what they decided, each at the
 * point it decides it, and the read serves the last of it.
 *
 * - **The pin watch** (`pins.ts`) writes, once a pass, every pin pull request and issue of the App's it read: the open
 *   ones, with the moves each carries by the day's names (a lockfile's package apart), and those merged or closed in
 *   the last `SETTLED_DAYS`, from the list of the App's `pin` items it reads anyway. An issue says why it was opened
 *   (`PATCH_ISSUES`), and for one the scan's pin step refused, the kind of refusal. It writes Dependabot's open pull
 *   requests for a pin the day lists, too, and each that has since left the open list as merged or closed.
 * - **The queues** (`deploy-queue.ts`) write what they decide of each open pull request at its head: the review gate's
 *   rule there, its required checks (their state, the try and how many the worker gives, and each that failed by its
 *   name and its Actions run), whether it is in the merge queue, and why not (`PATCH_HOLDS`).
 *
 * Kept in memory, per repository. After a restart, until each watch that writes a repository has made one pass over
 * it, the read fails (`PullsUnread`): an empty list there would say nothing is open.
 *
 * Only the factory's own words, and GitHub's numbers and times: nothing of a pull request's title, body or comments,
 * nor of Dependabot's. A body is read only for the marks the App wrote in it.
 */
import type { GateRule, PatchHold, PatchIssue, PayloadOf, PinRefusal } from '@software-factory/events';
import { MOST_PULLS, SETTLED_DAYS } from '@software-factory/events/schemas';
import { z } from 'zod';
import { type Dismissal, latestSay, type Review } from '../../../../policy/reviews.ts';
import { ACTIONS_APP } from '../gates/counts.ts';
import { APP_LOGIN, checksRunOf } from './actions.ts';
import type { GitHub } from './client.ts';
import { DEPENDABOT, type DependencyPull, groupMovesTo } from './dependabot.ts';
import type { ReviewVerdict } from './merging.ts';
import { type CheckRun, finished, outcomeOf } from './reads.ts';
import type { ReadMove } from './scanning.ts';

/** A pull request or issue that carries a move, as `patching.read` holds it. */
export type PatchPull = PayloadOf<'patching.read'>['repositories'][number]['pulls'][number];
/** One move it carries: its name in the day, and a lockfile's package apart. */
export type PullMove = PatchPull['moves'][number];
export type PullChecks = NonNullable<PatchPull['checks']>;

/** What the read `pulls` answers: the repository, and each of its pull requests and issues that carries a move. */
export interface RepositoryPulls {
  repository: string;
  pulls: PatchPull[];
}

/** What a queue says of an open pull request at a head. */
export interface QueueSay {
  rule?: GateRule;
  checks?: PullChecks;
  queued?: true;
  hold?: PatchHold;
}

/** One the pin watch saw: what it is and where it stands, before any queue's say of it. */
export type Seen = PatchPull;

/** The watches that write a repository's pull requests, each of which must have made a pass before the read answers. */
export type PullSource = 'pins' | 'dependabot' | 'pin-queue' | 'workflow-queue';

/**
 * The watches that write a repository's pull requests in a worker: none in one that cannot write, which runs none, so
 * its read answers at once with nothing; otherwise the pin watch and Dependabot's, and the queue the repository has.
 */
export function pullSources(
  repo: string,
  {
    writes,
    pinRepos,
    workflowPinRepos,
  }: { writes: boolean; pinRepos: readonly string[]; workflowPinRepos: readonly string[] },
): PullSource[] {
  if (!writes) return [];
  return [
    'pins',
    'dependabot',
    ...(pinRepos.includes(repo) ? (['pin-queue'] as const) : []),
    ...(workflowPinRepos.includes(repo) ? (['workflow-queue'] as const) : []),
  ];
}

/** The read's failure while a watch that writes the repository has not made a pass since the worker started. */
export class PullsUnread extends Error {
  override name = 'PullsUnread';
}

const DAY_MS = 24 * 60 * 60_000;

interface RepositoryState {
  seen: Map<number, Seen>;
  says: Map<number, { head: string; say: QueueSay }>;
  passed: Set<PullSource>;
}

export class PullStates {
  readonly #repos = new Map<string, RepositoryState>();
  readonly #sources: (repo: string) => readonly PullSource[];
  readonly #now: () => number;

  /** `sources` names the watches that write each repository: its read waits for a pass of every one. */
  constructor({ sources, now = Date.now }: { sources: (repo: string) => readonly PullSource[]; now?: () => number }) {
    this.#sources = sources;
    this.#now = now;
  }

  #repo(repo: string): RepositoryState {
    let state = this.#repos.get(repo);
    if (!state) {
      state = { seen: new Map(), says: new Map(), passed: new Set() };
      this.#repos.set(repo, state);
    }
    return state;
  }

  /**
   * What a watch saw of its kinds of pull request and issue in a pass, whole: every one of those kinds it does not name
   * is gone. A move whose package it does not know (a settled lockfile's, after a restart) keeps the package it was
   * last seen with.
   */
  saw(repo: string, source: 'pins' | 'dependabot', seen: readonly Seen[]): void {
    const state = this.#repo(repo);
    const kinds: readonly PatchPull['kind'][] = source === 'pins' ? ['pin', 'issue'] : ['dependabot'];
    const before = state.seen;
    const next = new Map([...before].filter(([, each]) => !kinds.includes(each.kind)));
    for (const each of seen) {
      const was = before.get(each.number ?? 0);
      // What it carried is what it was seen carrying: a settled one's marks name its lockfile moves, not their packages.
      const moves = !was ? each.moves : each.state !== 'open' ? was.moves : withPackages(each.moves, was.moves);
      next.set(each.number ?? 0, { ...each, moves });
    }
    state.seen = next;
    state.passed.add(source);
  }

  /** Dependabot's pull requests last seen open: those to look for as merged or closed once they leave the open list. */
  openDependabot(repo: string): Seen[] {
    return [...this.#repo(repo).seen.values()].filter((each) => each.kind === 'dependabot' && each.state === 'open');
  }

  /** Dependabot's pull requests last seen settled: kept while they are within `SETTLED_DAYS`. */
  settledDependabot(repo: string): Seen[] {
    return [...this.#repo(repo).seen.values()].filter((each) => each.kind === 'dependabot' && each.state !== 'open');
  }

  /**
   * A queue's say of an open pull request at a head: in place of what it said before when `replace` (each pass starts
   * so), and otherwise added to what it said at that head this pass.
   */
  say(repo: string, number: number, head: string, say: QueueSay, replace = false): void {
    const { says } = this.#repo(repo);
    const was = says.get(number);
    says.set(number, { head, say: replace || was?.head !== head ? say : { ...was.say, ...say } });
  }

  /** A queue's pass made: the pull requests it no longer reads as open are forgotten. */
  passedQueue(repo: string, source: 'pin-queue' | 'workflow-queue', open: ReadonlySet<number>): void {
    const state = this.#repo(repo);
    // A queue reads one kind of pull request: what another queue said is kept for that one to forget.
    for (const [number] of state.says) {
      const kind = state.seen.get(number)?.kind;
      const its = source === 'pin-queue' ? kind !== 'dependabot' : kind !== 'pin';
      if (its && !open.has(number)) state.says.delete(number);
    }
    state.passed.add(source);
  }

  /**
   * Every pull request and issue of the repository that carries a move: the open ones, oldest first, each with what its
   * queue last said of it; then those settled in `SETTLED_DAYS`, newest first; `MOST_PULLS` in
   * all. Fails while a watch that writes the repository has not made a pass.
   */
  read(repo: string): RepositoryPulls {
    const state = this.#repo(repo);
    const missing = this.#sources(repo).filter((source) => !state.passed.has(source));
    if (missing.length)
      throw new PullsUnread(
        `The worker has not read ${repo}'s pull requests whole since it started (${missing.join(', ')} to come): ask again shortly.`,
      );
    const since = this.#now() - SETTLED_DAYS * DAY_MS;
    const open: PatchPull[] = [];
    const settled: PatchPull[] = [];
    for (const each of state.seen.values()) {
      if (each.state !== 'open') {
        if (each.settled !== undefined && Date.parse(each.settled) >= since) settled.push(each);
        continue;
      }
      // The queue reads the open pull requests each minute, the pin watch each hour: its say is of the head it is at.
      const say = each.number === undefined ? undefined : state.says.get(each.number)?.say;
      // A queue that says nothing of it (not one it queues) leaves what the watch that saw it gave.
      if (!say || !Object.keys(say).length) {
        open.push(each);
        continue;
      }
      open.push({ ...withoutSay(each), ...say });
    }
    const byTime = (a: PatchPull, b: PatchPull, at: (p: PatchPull) => string) =>
      at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : (a.number ?? 0) - (b.number ?? 0);
    open.sort((a, b) => byTime(a, b, (p) => p.opened));
    settled.sort((a, b) => byTime(b, a, (p) => p.settled ?? ''));
    return { repository: repo, pulls: [...open, ...settled].slice(0, MOST_PULLS) };
  }
}

/** A pull request with nothing a queue says of it: what the watch that saw it gave stands only without a queue's say. */
const withoutSay = ({ rule: _r, checks: _c, queued: _q, hold: _h, ...rest }: PatchPull): PatchPull => rest;

/** Moves seen now, each that has no package taking the one a move of the same name was seen with before, once. */
function withPackages(now: readonly PullMove[], before: readonly PullMove[]): PullMove[] {
  const known = before.filter((each) => each.package !== undefined);
  const taken = new Set(now.flatMap((each) => each.package ?? []));
  return now.map((each) => {
    if (each.package !== undefined) return each;
    const found = known.find((was) => was.name === each.name && !taken.has(was.package as string));
    if (!found?.package) return each;
    taken.add(found.package);
    return { ...each, package: found.package };
  });
}

/** A move as a pull request carries it: its name, and for a lockfile's, its package apart. */
export const pullMove = (move: Pick<ReadMove, 'name' | 'lockfile' | 'withheld'>): PullMove => ({
  name: move.name,
  lockfile: move.lockfile,
  ...(move.lockfile && move.withheld ? { package: move.withheld.package } : {}),
});

/**
 * Whether a move's name is a lockfile's, which the scan names by its files alone (`publicMove`, moves.ts: "a package in
 * \`<file>\`", files joined by "and"): what a description's mark or an issue gives of a move the day no longer lists.
 * No other move's name has a space or a backtick.
 */
export const lockfileName = (name: string): boolean => /^a package in `[^`]+`(?: and `[^`]+`)*$/.test(name);

/** A move known by its name alone, from a mark the App wrote: a lockfile's is said so by its name. */
export const namedMove = (name: string): PullMove => ({ name, lockfile: lockfileName(name) });

/**
 * At most the moves the day's schema holds of one pull request, each once. Lockfile moves known by their name alone are
 * each a move of their own: one pull request carries every lockfile move of the day under the one name.
 */
export function pullMoves(moves: readonly PullMove[]): PullMove[] {
  const seen = new Set<string>();
  return moves
    .filter((each) => {
      if (each.lockfile && each.package === undefined) return true;
      const key = `${each.name}\n${each.package ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
}

/** Whether a time is within `SETTLED_DAYS` of now. */
export const recent = (at: string | null | undefined, now: number): at is string =>
  typeof at === 'string' && Date.parse(at) >= now - SETTLED_DAYS * DAY_MS;

const CLOSED_BY = z.object({ closed_by: z.object({ login: z.string() }).nullable().optional() });

/**
 * Whether a person closed an issue or pull request: anyone but the App and Dependabot, by GitHub's `closed_by` on the
 * issue (one conditional read, which the pin watch's own read of who closed it shares). Nobody GitHub names is no
 * person's close.
 */
export async function closedByPerson(github: GitHub, repo: string, number: number): Promise<boolean> {
  const { body } = await github.poll(repo, `/repos/${repo}/issues/${number}`, CLOSED_BY);
  const by = body.closed_by?.login;
  return by !== undefined && by !== APP_LOGIN && by !== DEPENDABOT;
}

const MESSAGE = z.object({ message: z.string() });

/** The most tries a head's checks are counted to in the day: its schema's bound. */
const MOST_TRIES = 9;

/**
 * How the required checks stand on a head, by the latest run of each but the gate's (`latest`, as the queue reads them):
 * failed when one failed, running while one has not finished or has no run, and passed otherwise; the try, from the
 * head's `Checks-run:` line, of `of` the worker gives a head; each that failed by its name and its Actions run.
 */
export async function checksAt(
  github: GitHub,
  repo: string,
  head: string,
  latest: readonly CheckRun[],
  names: readonly string[],
  of: number,
): Promise<PullChecks> {
  const failed = latest.filter((run) => finished(run) && outcomeOf(run.conclusion) === 'failure');
  const running = names.some((name) => {
    const run = latest.find((each) => each.name === name);
    return !run || !finished(run);
  });
  // A head the worker never writes again has one try; one it does, the try its message counts.
  const tried =
    of > 1 ? checksRunOf((await github.poll(repo, `/repos/${repo}/git/commits/${head}`, MESSAGE)).body.message) : 1;
  return {
    state: failed.length ? 'failed' : running ? 'running' : 'passed',
    try: Math.min(tried, MOST_TRIES),
    of: Math.min(of, MOST_TRIES),
    failed: failed
      .flatMap((run) => {
        const id = run.app === ACTIONS_APP ? run.run : undefined;
        return id === undefined ? [] : [{ name: [...run.name].slice(0, 120).join(''), run: id }];
      })
      .slice(0, 10),
  };
}

/** The gate's rule at a head, once it judged it: absent while it has not, or waits to judge again. */
export function ruleAt(verdict: Pick<ReviewVerdict, 'head' | 'judged'>, head: string): GateRule | undefined {
  const { judged } = verdict;
  if (verdict.head !== head || judged?.head !== head || judged.pending !== undefined) return undefined;
  return judged.rule;
}

const REVIEWS = z.array(
  z.object({
    id: z.number().int().optional(),
    user: z.object({ id: z.number().int() }).nullable(),
    state: z.string(),
    commit_id: z.string().nullable().optional(),
  }),
);
const EVENTS = z.array(
  z.object({
    event: z.string(),
    actor: z.object({ id: z.number().int() }).nullable().optional(),
    dismissed_review: z.object({ state: z.string(), review_id: z.number().int() }).optional(),
  }),
);

/** The most pages of a hundred read of a pull request's reviews or events: the gate reads them whole. */
const REVIEW_PAGES = 30;

/**
 * Every page GitHub gives of a list, oldest first, up to `REVIEW_PAGES`: Martin's latest review may be past the first
 * hundred on a pull request others reviewed often. Past them, what is read decides, which only names the hold.
 */
async function pages<T>(github: GitHub, repo: string, path: string, schema: z.ZodType<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= REVIEW_PAGES; page++) {
    const { body } = await github.poll(repo, `${path}&page=${page}`, schema);
    out.push(...body);
    if (body.length < 100) break;
  }
  return out;
}

/**
 * Why the gate's verdict keeps a pull request from the queue: not judged at its head yet (`verdict`); held because
 * Martin asked for changes, which the gate reads from his reviews as `policy/reviews.ts` has it, read here the same way
 * (`changes-requested`); held otherwise (`held`), which for one of Dependabot's (`dependabot`), a third-party action's,
 * is Martin's to merge at every level (`martin`); or passed by a rule the worker never queues, as Martin's approval of
 * a head the gate held is (`martin`).
 */
export async function gateHold(
  github: GitHub,
  repo: string,
  number: number,
  verdict: Pick<ReviewVerdict, 'head' | 'judged'>,
  head: string,
  dependabot = false,
): Promise<PatchHold> {
  const rule = ruleAt(verdict, head);
  if (rule === undefined) return 'verdict';
  if (rule !== 'held') return 'martin';
  const reviews: Review[] = (
    await pages(github, repo, `/repos/${repo}/pulls/${number}/reviews?per_page=100`, REVIEWS)
  ).map(({ id, ...each }) => ({
    ...each,
    ...(id !== undefined ? { id } : {}),
    commit_id: each.commit_id ?? null,
  }));
  // A dismissal says by whom only in the pull request's events: read only when a review was dismissed.
  const events: Dismissal[] = reviews.some((each) => each.state === 'DISMISSED')
    ? (await pages(github, repo, `/repos/${repo}/issues/${number}/events?per_page=100`, EVENTS)).map((each) => ({
        event: each.event,
        actor: each.actor ?? null,
        ...(each.dismissed_review ? { dismissed_review: each.dismissed_review } : {}),
      }))
    : [];
  // As the gate judges a pull request the App opened: only Martin's reviews count (`review-routing.ts`'s `verdict`).
  const asked = latestSay(reviews, events).say === 'asked';
  return asked ? 'changes-requested' : dependabot ? 'martin' : 'held';
}

/** Where a pull request's pins are: a pin's directory as `dependabot.yml` writes one, `/` at the root. */
const directoryOf = (file: string) => `/${file.split('/').slice(0, -1).join('/')}`;
const bare = (name: string) => name.replace(/^@/, '');

/**
 * The day's moves a pull request of Dependabot's makes, from its branch and the lines it changes alone, never its title
 * or body (`dependabot.ts`), as the line finds the one its own replaces (`replacedPull`): a branch that names a pin, by
 * its dependency (a lockfile's move by its package, any other by its name or the end of it, as an image's is named
 * with its registry) and the directory of one of the move's pins, or for GitHub Actions any workflow's; a group's, by
 * a line it rewrites at one of the move's pins.
 */
export function dependabotCarries(pull: DependencyPull, moves: readonly ReadMove[]): ReadMove[] {
  return moves.filter((move) => {
    const pins = move.withheld?.pins ?? move.pins;
    if (pull.dependency === null || pull.directory === null)
      return pins.some((pin) => groupMovesTo(pull, pin) !== undefined);
    const dependency = bare(pull.dependency);
    const name = bare(move.lockfile ? (move.withheld?.package ?? '') : move.name);
    if (name !== dependency && !name.endsWith(`/${dependency}`)) return false;
    if (pull.ecosystem === 'github-actions') return pins.some((pin) => pin.file.startsWith('.github/'));
    const directory = pull.directory.replace(/\/+$/, '') || '/';
    return pins.some((pin) => (directoryOf(pin.file).replace(/\/$/, '') || '/') === directory);
  });
}

/**
 * What the worker does with a pull request of Dependabot's that it does not queue: one of a workflow's pins alone is
 * Martin's to merge at every level (AGENTS.md: every workflow pin but the one the worker queues, and every third-party
 * action's); any other waits for the factory's own move, and Dependabot closes it once `main` has the version.
 */
export const dependabotHold = (moves: readonly ReadMove[]): PatchHold | undefined =>
  moves.length > 0 && moves.every((move) => move.pins.every((pin) => pin.file.startsWith('.github/')))
    ? 'martin'
    : undefined;

const PULL = z.object({
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
});

/**
 * What Dependabot's pull requests the pin watch last saw open became, once gone from the open list: merged or closed,
 * when, and whether by a person; one GitHub no longer has, or still says is open, is left out.
 */
export async function settledDependabot(github: GitHub, repo: string, gone: readonly Seen[]): Promise<Seen[]> {
  const out: Seen[] = [];
  for (const each of gone) {
    if (each.number === undefined) continue;
    const { body } = await github.poll(repo, `/repos/${repo}/pulls/${each.number}`, PULL);
    if (body.state === 'open') continue;
    const settled = body.merged_at ?? body.closed_at;
    if (!settled) continue;
    const { rule: _r, checks: _c, queued: _q, hold: _h, ...rest } = each;
    out.push({
      ...rest,
      state: body.merged_at ? 'merged' : 'closed',
      settled,
      ...(body.merged_at ? {} : { closedByPerson: await closedByPerson(github, repo, each.number) }),
    });
  }
  return out;
}

export type { PatchIssue, PinRefusal };
