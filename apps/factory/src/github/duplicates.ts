/**
 * Dependabot's pull request for versions `main` already has, closed by the worker with one comment: the second thing
 * the factory does to a pull request it did not open (guardrail 10, `issues.ts`), and the only write here.
 *
 * Dependabot proposes moves the factory makes itself (the pin watch here, the line in the app), and closes its own
 * pull request only when it notices `main` has the version, which it sometimes never does. One left open says a move
 * waits that does not.
 *
 * - **What is closed.** A pull request Dependabot opened, by its numeric id, from a `dependabot/` branch of the
 *   repository into `main`, when every change it makes is already in `main`'s files as they stand
 *   (`closeDuplicate`). Its changes are read from GitHub, as the patch of each file it changes: the lines each change
 *   adds must be in `main`'s file, together and in the patch's order, and the lines it removes must be nowhere in it
 *   (`appliedIn`), so a pin moved at one place of a file and not at another like it is not taken for moved. A file
 *   whose patch GitHub does not send, a renamed file, or a count of files that is not the pull
 *   request's own cannot be read whole, and nothing is closed. One that changes no file at all has nothing left to
 *   move. Nothing is read from its title, its body or its branch's name, and no version is compared with another.
 * - **Never one that still moves anything.** A version `main` lacks, in any file, is a line `main` does not have: the
 *   pull request stays, for Dependabot, the factory's own move or Martin.
 * - **At one head of each.** What it changes is judged at the pull request's head and `main`'s head as read then, and
 *   both are read again just before anything is written: a push to either since is a conflict, and the next pass
 *   judges again.
 * - **Once.** The comment begins `MAIN_HAS_IT` and names what brought each version to `main`, where git's blame of
 *   the lines gives it: the pull request, or the commit. A pull request the App closed before, opened again by
 *   anyone, is left as it is: it is not closed or commented on twice.
 * - **For the watch alone.** The guard passes the close for the asker `duplicate-watch`, which `closeDuplicate` says
 *   itself; it is no action of the worker's door (`actions.ts`), so no worker can ask for it, and a dry run, whose
 *   worker runs no such watch, makes none.
 *
 * Closing tells Dependabot not to propose those versions again, which is right while `main` has them.
 */
import type { Logger } from 'pino';
import { z } from 'zod';
import { BranchRefused, plainBranch } from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import { APP_USER, DEPENDABOT_USER, type IssueGuard, IssueRefused } from './issues.ts';
import { PatchRefused } from './patches.ts';
import type { PinSource } from './pin-guard.ts';
import type { Watch } from './poller.ts';
import type { RefusalRecorder } from './refusals.ts';

/** How the comment on a duplicate begins, word for word. */
export const MAIN_HAS_IT = '`main` already has every version this moves';

/** Where every branch of Dependabot's starts. */
export const DEPENDABOT_PREFIX = 'dependabot/';

/** One change of a patch: a run of lines it removes and the run it puts in their place, either of which may be empty. */
export interface Change {
  removed: string[];
  added: string[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * A patch's changes, as GitHub sends a file's: within each hunk, each run of removed and added lines between lines of
 * context. Undefined for one that does not read as a patch, or changes nothing.
 */
export function changesOf(patch: string): Change[] | undefined {
  const changes: Change[] = [];
  let hunk = false;
  let change: Change | undefined;
  for (const line of patch.split('\n')) {
    // git's note that a file ends without a newline is no line of the file.
    if (line.startsWith('\\')) continue;
    if (HUNK.test(line)) {
      hunk = true;
      change = undefined;
    } else if (!hunk) return undefined;
    else if (line.startsWith('-') || line.startsWith('+')) {
      if (!change) {
        change = { removed: [], added: [] };
        changes.push(change);
      }
      (line.startsWith('-') ? change.removed : change.added).push(line.slice(1));
    } else if (line.startsWith(' ') || line === '') change = undefined;
    else return undefined;
  }
  return changes.length ? changes : undefined;
}

/** Where a run of lines is in a file, together and in order, at or after a line: its first line's place, or -1. */
function runIn(lines: readonly string[], run: readonly string[], from = 0): number {
  for (let at = from; at + run.length <= lines.length; at++)
    if (run.every((text, i) => lines[at + i] === text)) return at;
  return -1;
}

/**
 * Whether a file already has a patch's changes: the lines each adds are in it, together, one change after another,
 * and the lines each removes are nowhere in it, together. The context a patch shows around a change is not asked
 * for: the file may have moved on around it. Answers the file's line (from 1) of each line the patch adds, or why the
 * file has not the patch.
 */
export function appliedIn(lines: readonly string[], changes: readonly Change[]): number[] | string {
  const added: number[] = [];
  let from = 0;
  for (const change of changes) {
    const at = runIn(lines, change.added, from);
    if (at < 0) return `it has no ${JSON.stringify(change.added[0])}`;
    // The lines before, still somewhere in the file: this place, or one like it, has not moved.
    if (change.removed.length && runIn(lines, change.removed) >= 0)
      return `it still has ${JSON.stringify(change.removed[0])}`;
    added.push(...change.added.map((_, i) => at + i + 1));
    from = at + change.added.length;
  }
  return added;
}

/** A pull request as the close reads it, from GitHub. */
const PULL = z.object({
  state: z.string(),
  user: z.object({ id: z.number().int() }).nullable(),
  changed_files: z.number().int().nonnegative(),
  head: z.object({
    ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});
type Pull = z.infer<typeof PULL>;

const FILES = z.array(
  z.object({
    filename: z.string(),
    status: z.string(),
    patch: z.string().optional(),
  }),
);

/** The most files of one pull request read: thirty pages. One with more is not read whole, and is left. */
const FILE_PAGES = 30;

/**
 * Throws `BranchRefused` unless a pull request is one of Dependabot's own to close: opened by Dependabot, by its id,
 * from a plain `dependabot/` branch of this repository, into this repository's `main`. A fork's branch of that name,
 * anyone else's pull request from a branch named like Dependabot's, and one into another branch, whose changes
 * `main` having says nothing of, are refused.
 */
export function guardDuplicate(repo: string, number: number, pull: Pull): void {
  if (pull.user?.id !== DEPENDABOT_USER)
    throw new BranchRefused(`Pull request #${number} is not Dependabot's: the factory closes no other as a duplicate.`);
  if (pull.head.repo?.full_name !== repo || pull.base.repo?.full_name !== repo)
    throw new BranchRefused(`Pull request #${number} is not from a branch of ${repo} into ${repo}.`);
  const { ref } = pull.head;
  if (!plainBranch(ref) || !ref.startsWith(DEPENDABOT_PREFIX) || ref.length === DEPENDABOT_PREFIX.length)
    throw new BranchRefused(`${ref} is not one of Dependabot's branches under ${DEPENDABOT_PREFIX}.`);
  if (pull.base.ref !== 'main')
    throw new BranchRefused(
      `Dependabot's ${ref} is into ${pull.base.ref}, not main: what main has says nothing of it.`,
    );
}

/** A line of `main` that a pull request adds, already there. */
interface Had {
  file: string;
  line: number;
}

/**
 * Whether `main`, at a commit, has every change a pull request makes, from the patch of each file it changes:
 * the lines it adds, where they are in `main`'s files, or why it cannot be said that `main` has them all.
 */
export async function mainHas(
  github: GitHub,
  source: PinSource,
  repo: string,
  number: number,
  changed: number,
  main: string,
): Promise<{ had: Had[] } | { why: string }> {
  const files: z.infer<typeof FILES> = [];
  for (let page = 1; page <= FILE_PAGES; page++) {
    const body = await github.read(repo, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, FILES);
    files.push(...body);
    if (body.length < 100) break;
  }
  // GitHub's own count of them, from the pull request: a list cut short, or of another head, is not it.
  if (files.length !== changed) return { why: `GitHub lists ${files.length} of the ${changed} files it changes` };
  const had: Had[] = [];
  for (const file of files) {
    let there: Awaited<ReturnType<PinSource['file']>>;
    try {
      there = await source.file(repo, main, file.filename);
    } catch (error) {
      // A tree GitHub cut short, or a file that is not text: not read, so not known to be there.
      if (error instanceof PatchRefused) return { why: error.message };
      throw error;
    }
    if (file.status === 'removed') {
      if (there) return { why: `main still has ${file.filename}, which it deletes` };
      continue;
    }
    if (file.status !== 'modified' && file.status !== 'added' && file.status !== 'changed')
      return { why: `${file.filename} is ${file.status}, which is not read` };
    if (file.patch === undefined) return { why: `GitHub sends no patch of ${file.filename}` };
    const changes = changesOf(file.patch);
    if (!changes) return { why: `the patch of ${file.filename} does not read as one` };
    if (!there || (there.mode !== '100644' && there.mode !== '100755'))
      return { why: `main has no file ${file.filename}` };
    const lines = appliedIn(there.text.split('\n'), changes);
    if (typeof lines === 'string') return { why: `main's ${file.filename}: ${lines}` };
    had.push(...lines.map((line) => ({ file: file.filename, line })));
  }
  return { had };
}

const BLAME = `query($owner: String!, $name: String!, $oid: GitObjectID!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        blame(path: $path) {
          ranges {
            startingLine
            endingLine
            commit { oid associatedPullRequests(first: 5) { nodes { number merged baseRefName } } }
          }
        }
      }
    }
  }
}`;

const BLAMED = z.object({
  repository: z.object({
    object: z
      .object({
        blame: z
          .object({
            ranges: z.array(
              z.object({
                startingLine: z.number().int(),
                endingLine: z.number().int(),
                commit: z.object({
                  oid: z.string().regex(/^[0-9a-f]{40}$/),
                  associatedPullRequests: z.object({
                    nodes: z.array(
                      z.object({ number: z.number().int(), merged: z.boolean(), baseRefName: z.string() }),
                    ),
                  }),
                }),
              }),
            ),
          })
          .optional(),
      })
      .nullable(),
  }),
});

/** The most files blamed, and the most merges a comment names. */
const MOST_BLAMED = 5;
const MOST_NAMED = 5;

/**
 * What brought the lines to `main`, by git's blame of each at that commit: the pull request merged into `main` that
 * its commit came with, as `#12`, or the commit. In the order of the lines, each once.
 */
export async function broughtBy(github: GitHub, repo: string, main: string, had: readonly Had[]): Promise<string[]> {
  const [owner, name] = repo.split('/');
  const named = new Set<string>();
  for (const path of [...new Set(had.map((each) => each.file))].slice(0, MOST_BLAMED)) {
    const answer = await github.graphql(repo, BLAME, { owner, name, oid: main, path }, BLAMED);
    const ranges = answer.repository.object?.blame?.ranges ?? [];
    for (const { line } of had.filter((each) => each.file === path)) {
      const commit = ranges.find((range) => range.startingLine <= line && line <= range.endingLine)?.commit;
      if (!commit) continue;
      const merged = commit.associatedPullRequests.nodes.find((pull) => pull.merged && pull.baseRefName === 'main');
      named.add(merged ? `#${merged.number}` : commit.oid.slice(0, 12));
    }
  }
  return [...named];
}

const listed = (names: readonly string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The comment a duplicate is closed with: that `main` has it all, what brought it there where that is known, and what closing does. */
export function duplicateComment(brought: readonly string[]): string {
  const shown = brought.slice(0, MOST_NAMED);
  const more = brought.length - shown.length;
  const with_ = shown.length ? `: they came with ${listed(more > 0 ? [...shown, `${more} more`] : shown)}.` : '.';
  return `${MAIN_HAS_IT}${with_} Nothing is left for this pull request to move, so the factory closes it. Closing it tells Dependabot not to propose these versions again, which is right while \`main\` has them.`;
}

const COMMENTS = z.array(
  z.object({ body: z.string().nullable().optional(), user: z.object({ id: z.number().int() }).nullable() }),
);
const EVENTS = z.array(
  z.object({ event: z.string(), actor: z.object({ id: z.number().int() }).nullable().optional() }),
);
const REF = z.object({ object: z.object({ sha: z.string() }) });

/** The most pages of a pull request's events read to learn whether the App closed it before. */
const EVENT_PAGES = 3;

export interface DuplicateDependencies {
  github: GitHub;
  /** The worker's guard, which passes this close on Dependabot's pull request, for this asker alone. */
  guard: IssueGuard;
  /** `main`'s head and files, as git has them (`treeSource`). */
  source: PinSource;
}

/** What became of a pull request the close looked at. */
export type Duplicate =
  | { closed: true; main: string; head: string; brought: string[] }
  /** Left open: `final` when nothing but a person's act would change that. */
  | { closed: false; why: string; final?: true };

/**
 * Closes a pull request of Dependabot's when `main` already has every change it makes, with one comment first. See
 * the module's comment for what it holds. Throws `IssueRefused` for one neither Dependabot's nor the App's (the
 * guard's, recorded), `BranchRefused` for one that is not Dependabot's own from its branch into `main`, and a
 * `conflict` when the pull request or `main` moved while it was judged.
 */
export async function closeDuplicate(deps: DuplicateDependencies, repo: string, number: number): Promise<Duplicate> {
  const { github, guard, source } = deps;
  const opener = await guard.check(repo, number, 'closePullRequest', undefined, 'duplicate-watch');
  if (opener !== 'dependabot')
    throw new BranchRefused(`Pull request #${number} is not Dependabot's: the factory closes no other as a duplicate.`);
  const path = `/repos/${repo}/pulls/${number}`;
  const pull = await github.read(repo, path, PULL);
  guardDuplicate(repo, number, pull);
  if (pull.state !== 'open') return { closed: false, why: 'it is not open', final: true };
  const main = await source.head(repo);
  const has = await mainHas(github, source, repo, number, pull.changed_files, main);
  if ('why' in has) return { closed: false, why: has.why };

  // Whether the App said so here before, and then whether it closed it: one opened again since is left as it is.
  const comments = await github.read(repo, `/repos/${repo}/issues/${number}/comments?per_page=100`, COMMENTS);
  if (comments.length >= 100)
    return { closed: false, why: 'it has more comments than are read for the factory’s own', final: true };
  const said = comments.some((each) => each.user?.id === APP_USER && (each.body ?? '').startsWith(MAIN_HAS_IT));
  if (said) {
    for (let page = 1; ; page++) {
      const events = await github.read(
        repo,
        `/repos/${repo}/issues/${number}/events?per_page=100&page=${page}`,
        EVENTS,
      );
      if (events.some((each) => each.event === 'closed' && each.actor?.id === APP_USER))
        return { closed: false, why: 'the factory closed it once, and it was opened again', final: true };
      if (events.length < 100) break;
      if (page === EVENT_PAGES)
        return { closed: false, why: 'it has more events than are read for the factory’s own close', final: true };
    }
  }
  // What brought the versions is said where it can be read; the close does not wait on it.
  const brought = said ? [] : await broughtBy(github, repo, main, has.had).catch(() => []);

  // Both heads again, just before anything is written: what was judged is what is closed.
  const [now, ref] = await Promise.all([
    github.read(repo, path, PULL),
    github.read(repo, `/repos/${repo}/git/ref/heads/main`, REF),
  ]);
  guardDuplicate(repo, number, now);
  if (now.state !== 'open') return { closed: false, why: 'it is not open', final: true };
  if (now.head.sha !== pull.head.sha)
    throw new GitHubError('conflict', `Pull request #${number} moved while it was read: it is judged again.`, 409);
  if (ref.object.sha !== main)
    throw new GitHubError('conflict', `main moved while pull request #${number} was read: it is judged again.`, 409);
  if (!said)
    await github.write(repo, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: duplicateComment(brought) });
  await github.write(repo, 'PATCH', path, { state: 'closed' });
  return { closed: true, main, head: pull.head.sha, brought };
}

const OPEN = z.array(
  z.object({
    number: z.number().int().positive(),
    user: z.object({ id: z.number().int() }).nullable(),
    head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    base: z.object({ ref: z.string() }),
  }),
);

/** The most pages of open pull requests read: any past them are left for a pass that reaches them. */
const OPEN_PAGES = 10;

export interface DuplicateWatchDependencies extends DuplicateDependencies {
  /** What keeps, logs and signs a refusal of the close's own; the guard keeps its own. */
  recorder?: RefusalRecorder | undefined;
  log: Logger;
}

/**
 * Watches a repository's open pull requests of Dependabot's, and closes each `main` already has every change of
 * (`closeDuplicate`). One is judged once at its head and `main`'s, and again when either moves; one that cannot be
 * read holds only itself, and is tried again at the next pass.
 */
export function duplicateWatch(deps: DuplicateWatchDependencies, repo: string): Watch {
  const { github, recorder, log } = deps;
  /** What each open pull request was last judged at: its head and `main`'s, or `final` for one left for good. */
  const judged = new Map<number, string>();
  return async () => {
    const candidates: z.infer<typeof OPEN> = [];
    for (let page = 1; page <= OPEN_PAGES; page++) {
      const { body } = await github.poll(
        repo,
        `/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc&page=${page}`,
        OPEN,
      );
      candidates.push(
        ...body.filter(
          (pull) =>
            pull.user?.id === DEPENDABOT_USER &&
            pull.head.repo?.full_name === repo &&
            pull.head.ref.startsWith(DEPENDABOT_PREFIX) &&
            pull.base.ref === 'main',
        ),
      );
      if (body.length < 100) break;
    }
    for (const number of judged.keys()) if (!candidates.some((pull) => pull.number === number)) judged.delete(number);
    if (!candidates.length) return;
    const { body: ref } = await github.poll(repo, `/repos/${repo}/git/ref/heads/main`, REF);
    for (const { number, head } of candidates) {
      const at = `${head.sha} ${ref.object.sha}`;
      const before = judged.get(number);
      if (before === 'final' || before === at) continue;
      try {
        const result = await closeDuplicate(deps, repo, number);
        if (result.closed) {
          judged.set(number, 'final');
          log.info(
            { repo, number, head: result.head, main: result.main, brought: result.brought },
            'closed a pull request of Dependabot’s: main already has every version it moves',
          );
        } else {
          judged.set(number, result.final ? 'final' : at);
          log.debug(
            { repo, number, why: result.why },
            'a pull request of Dependabot’s stays: main has not all it moves',
          );
        }
      } catch (error) {
        if (error instanceof IssueRefused || error instanceof BranchRefused) {
          // Refused for what it is, which no pass changes: said once, and kept.
          judged.set(number, 'final');
          log.warn({ repo, number, err: error }, 'refused to close a pull request as Dependabot’s duplicate');
          if (error instanceof BranchRefused)
            await recorder
              ?.record({
                repo,
                number,
                mechanism: 'github-guard',
                cause: 'branch',
                action: `Close pull request #${number} in ${repo}`,
                output: error.message,
              })
              .catch((err: unknown) => log.error({ repo, number, err }, 'could not keep a refusal'));
        } else log.warn({ repo, number, err: error }, 'could not judge a pull request of Dependabot’s: tries again');
      }
    }
  };
}
