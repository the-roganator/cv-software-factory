/**
 * The pin watch (task 33): one pull request of the App's for the day's moves at one set of files, which replaces the
 * version or digest at each of their pins and changes nothing else; for each move the App cannot write, one issue.
 * Beside the deploy watch (`deploys.ts`), and like it the App's.
 *
 * Each pass, at most hourly, it reads the scan's day (`reads.moves`: the last finished run of `vulnerabilities.yml` on
 * `main`, its `moves.json` checked against the state the scan kept), and then:
 *
 * - **The moves in the `worker` and `cluster` lanes** are grouped by the files they pin (`branchOf`): Kyverno's four
 *   images in one values file are one pull request, and so is one chart at two Applications, a move of two files. A
 *   move the review gate will name `major` (across a major, clearing no Critical) rides apart from the rest of its
 *   file, since the autonomy level may hold it and the others must not wait for it; and a file's routine updates, the
 *   moves no finding asks for (`isRoutine`), ride apart from those one does, so a routine update whose checks fail
 *   holds up no fix. Each group is committed on `main`'s
 *   head, signed by GitHub as every commit of the App's is, through `commitPins`, whose guard (`pin-guard.ts`) lets the
 *   commit replace the version or digest at each pin and nothing else, and refuses, with a signed record, anything it
 *   cannot prove is that; then one pull request is opened from the branch, labelled `pin`. Its description is the
 *   factory's own: each pin before and after, what each move clears in counts and its deadline, or that it is a
 *   routine update, with no advisory behind it and no deadline, and how it merges. As the
 *   day's moves at its files change (a target moves on, a move joins or goes), its branch moves, in one forced update,
 *   and its title and description with it; one that conflicts with `main` is committed again on `main`'s head. A pull
 *   request Martin closed without merging it is not opened again for the same edits; one anyone else closed is. A
 *   branch that a pull request of someone else's stands on is not written, and an open GitHub refuses costs that
 *   branch alone: each is refused for the branch, with an issue for each of its moves, and the pass goes on to the
 *   rest. A worker started again keeps
 *   a branch whose head is already the commit it would write, so a restart sends no pull request round its checks
 *   again. Two moves that name one line are both refused, and the rest of their file's go on.
 * - **A move no pin's line writes**, a lockfile's package, what mise pins, or an image that brings another pin with it
 *   (the Node it runs, or Playwright's library in the lockfile), is made by the pin step in the scan's own run, on the
 *   commit it read (github/made.ts): the day's lockfile moves in one group, mise's in another, an image's with its
 *   Dockerfiles', each made on what the one before it wrote. The watch commits what the scan made, whole, once each file it wrote is the same at
 *   `main`'s head as there, through the same guard, which holds where it writes; the review gate makes the same moves
 *   again on main and compares. A move the step refused (pnpm's guards: a release younger than a day, a weaker
 *   provenance; a copy only an override would move) waits, with an issue that says so by its mark and says which kind
 *   of refusal it was (`refusalKind`), in the watch's own words for the kind, and the step's own words in the
 *   worker's log; the rest of its group go on.
 * - **It makes every move of its lanes, whoever else proposes one.** A pull request of Dependabot's for the same pin is
 *   left as it is: the watch never pushes to Dependabot's branch or closes its pull request (the actions refuse both,
 *   as a branch the factory does not own and a pull request the App did not open). Once `main` has the version,
 *   Dependabot closes it itself when it next looks at it, or the worker's watch of such duplicates does
 *   (`duplicates.ts`).
 * - **A move in the `issue` lane** (a workflow's pin), a line no longer built, a move the watch cannot write on its pins' lines, one the pin step refused, one undone on `main`, and one whose branch is held or whose pull request GitHub refused, is
 *   one issue, labelled `pin`, that a session can take as it stands: its pins, its target, its counts and its
 *   deadline. It is found again by the mark in its body, and updated, never opened twice; one Martin closed is opened
 *   again only for a later target.
 * - **A move whose merge was undone on `main`** is left unmade until its target changes: a merged pull request of the
 *   App's from the move's branch made this very move (its name, what it moved from and to, by the mark in its
 *   description), its merge is still in `main`'s history, and `main` again holds what it moved from, so someone put
 *   it back. It is said once in the log and is one issue, as below; a move the pin step makes waits with the rest of
 *   its group, which the step makes whole. A `main` whose history no longer has the merge (one written again from an
 *   earlier commit) has had nothing undone on it, and the move is made.
 * - **A pull request with no move left** is closed, with a sentence, and so is the issue of a move that is gone.
 * - **In the app's repository it keeps the issues alone** (`ISSUE_REPOS`): the app's moves are its line's, made from
 *   tickets, and no ticket is made for a move on a line no longer built (`none`), the one lane but `line` the scan
 *   gives an app's move (`laneOf`), so each is one issue there, opened, updated and closed as here. The watch reads
 *   no branch, file or pull request there and writes none: its pass there has the four actions on issues and no
 *   other (`issuesOnly`).
 *
 * What it writes names the move and its counts, never an advisory of an open finding, and never more of a lockfile's
 * move than its diff shows: its pull request names the package and the versions the lockfile resolves it at, before
 * and after, and none of what the scan found there; its issue, which has no diff, names it by its file and its mark
 * (scanning.ts's `ReadMove.mark`). A routine update has no finding behind it: the issue of one the pin step refused
 * names its package and the release too, as its pull request would have, and then none of what its pins have open.
 *
 * Nothing acts on a day it could not read whole: a moves read that fails, or a run that uploaded no `moves.json`, opens
 * and closes nothing. A `moves.json` that lists no move, its count held to the scan's state as every day's is, is a day
 * with nothing to move, and closes what the watch has open. A pin whose line has changed since the scan read it waits
 * for the next scan, and its pull request stays.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import { APP_REPOSITORY, FACTORY_REPOSITORY } from '../repositories.ts';
import { readTarget, type Target } from '../vulnerabilities/fixes.ts';
import { isRoutine } from '../vulnerabilities/moves.ts';
import { DIGEST_PATTERN, splitReference } from '../vulnerabilities/reference.ts';
import { libraryOf } from '../vulnerabilities/registry.ts';
import { SEVERITIES } from '../vulnerabilities/sarif.ts';
import { type Actions, APP_LOGIN } from './actions.ts';
import { BranchRefused, PIN_PREFIX, type WatchedHeads } from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import { MARTIN } from './issues.ts';
import { type Apart, groupKey, groupOf, type MadeGroup, madeByStep, namedMajor, writtenBy } from './made.ts';
import { isOwnCommit } from './own-commit.ts';
import { PatchRefused } from './patches.ts';
import {
  type PinCommit,
  type PinEdit,
  type PinSource,
  pinBranchFor,
  pinChanges,
  segmentOf,
  spans,
  treeSource,
} from './pin-guard.ts';
import type { Watch } from './poller.ts';
import type { Reads } from './reads.ts';
import type { RefusalRecorder } from './refusals.ts';
import type { Moves, ReadMove } from './scanning.ts';

/** The repositories whose pins the watch moves: this one. The app's moves are its line's. */
export const PIN_REPOS: readonly string[] = [FACTORY_REPOSITORY];

/**
 * The repositories where the watch keeps issues and nothing else: the app's, whose line makes its moves. A move there
 * that no ticket is made for, on a line no longer built, is an issue, as it is here: `laneOf` gives every other move
 * of the app's `line`.
 */
export const ISSUE_REPOS: readonly string[] = [APP_REPOSITORY];

/** The label on every pull request and issue the watch opens. */
export const PIN_LABEL = 'pin';

/** The lanes whose moves are in a pull request of the watch's, and those that are an issue. */
const PULL_LANES = new Set(['worker', 'cluster']);
const ISSUE_LANES = new Set(['issue', 'none']);

/** How often a pass reads the day: the scan runs daily, and a pass is idempotent. */
export const PASS_MS = 60 * 60_000;

export interface PinWatchDependencies {
  github: GitHub;
  reads: Pick<Reads, 'moves'>;
  actions: Pick<
    Actions,
    | 'dryRun'
    | 'commitPins'
    | 'openPullRequest'
    | 'updatePullRequest'
    | 'addLabels'
    | 'closePullRequest'
    | 'openIssue'
    | 'updateIssue'
    | 'closeIssue'
    | 'reopenIssue'
  >;
  /** What the watch reads of the tree to write its edits, as the guard reads it: git's trees by default. */
  source?: PinSource;
  /** What keeps, logs and signs a refusal of the guard's; without it, a refusal is only logged. */
  recorder?: RefusalRecorder | undefined;
  /**
   * Where the watch records the commit it wrote to each pin branch, for the pin queue (`deploy-queue.ts`). Given, a
   * branch at any other commit, moved by anyone, is written again; one this worker has not yet written is recorded as
   * it is when its head is already the commit the watch would write (`alreadyWritten`), and written again otherwise.
   */
  heads?: WatchedHeads;
  log: Logger;
  now?: () => number;
  /**
   * The moves it takes (`PIN_WATCH_ONLY`): `'*'` for every move of the day, or their names. A move outside it is in
   * no pull request the watch writes but the one of a group the pin step made whole with a move it names, and its
   * issue is never opened, updated or closed; told nothing (no names, the default), the watch takes no move at all.
   */
  only?: PinScope;
}

/** Which of the day's moves the watch takes: every one, or those named. */
export type PinScope = '*' | readonly string[];

/** `PIN_WATCH_ONLY` read: unset or blank names none, `*` alone every move, otherwise the names, comma-separated. */
export function readPinScope(text: string | undefined): PinScope {
  const names = (text ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.includes('*')) {
    if (names.length > 1) throw new Error(`PIN_WATCH_ONLY is ${JSON.stringify(text)}; * stands alone, for every move.`);
    return '*';
  }
  return [...new Set(names)];
}

const CLOSED_BY = z.object({
  closed_by: z.object({ login: z.string(), id: z.number().int().optional() }).nullable().optional(),
});
const PULLS = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    body: z.string().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    merge_commit_sha: z.string().nullable().optional(),
    user: z.object({ login: z.string() }).nullable(),
    labels: z.array(z.object({ name: z.string() })),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  }),
);
const MERGE_BASE = z.object({ merge_base_commit: z.object({ sha: z.string() }) });
const PULL = z.object({ mergeable: z.boolean().nullable() });
const BRANCH = z.object({ object: z.object({ sha: z.string() }) });
/** A file's bytes as text, every byte kept, as the guard reads a file from git (`treeSource`). */
const TEXT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const ISSUES = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    body: z.string().nullable().optional(),
    user: z.object({ login: z.string() }).nullable(),
    pull_request: z.unknown().optional(),
  }),
);
type Pull = z.infer<typeof PULLS>[number];
type Issue = z.infer<typeof ISSUES>[number];

/** The most pages of open pull requests, and of the watch's issues, read. */
const PAGES = 10;

/** GitHub's failures that may pass by the next pass: a limit, an outage. Any other answer to an open is a refusal. */
const PASSING: readonly string[] = ['rate-limited', 'server', 'network'];

/** The mark that finds a move's issue again, and the target it was written for. */
const ISSUE_MARK = /<!-- factory: pin-issue ([a-z0-9][a-z0-9.-]*) -->/;
/** The target, URI-encoded, so nothing in it can end the comment it is in. */
const TARGET_MARK = /<!-- factory: pin-target ([A-Za-z0-9%._~!*'()-]*) -->/;
const targetMark = (target: string) => encodeURIComponent(target);
/**
 * The mark that says which edits a pull request's branch was committed with: a change of them commits again, and a pull
 * request Martin closed is found again by it.
 */
const EDITS_MARK = /<!-- factory: pin-edits ([0-9a-f]{64}) -->/;
const editsHash = (edits: readonly PinEdit[]) => createHash('sha256').update(JSON.stringify(edits)).digest('hex');
/** The mark that names the moves a pull request carries, URI-encoded: what a watch told only some moves may close. */
const MOVES_MARK = /<!-- factory: pin-moves ([A-Za-z0-9%._~!*'()-]*) -->/;

/**
 * The mark that names each move a pull request makes, by a digest of the move's name, what it moves from and what it
 * moves to (`madeMark`): a merged pull request's says which moves `main` took by it, so one put back on `main` since
 * is known again, whatever else its files' moves are that day.
 */
const MADE_MARK = /<!-- factory: pin-made ([0-9a-f]{64}(?:,[0-9a-f]{64})*) -->/;
const madeMark = (name: string, from: string | readonly string[], to: string | readonly string[]) =>
  createHash('sha256')
    .update(JSON.stringify([name, from, to]))
    .digest('hex');

/** Each move a pull request makes, as `MADE_MARK` names it, with its place in `moves.json`. */
function madeOf(carried: readonly Carried[], written?: Written): { mark: string; move: number }[] {
  if (written)
    return written.made.steps.map((step) => ({ mark: madeMark(step.name, step.before, step.after), move: step.move }));
  return carried.map(({ move }) => ({ mark: madeMark(move.name, move.from, move.to), move: move.index }));
}

const madeLine = (made: readonly { mark: string }[]) =>
  made.length ? [`<!-- factory: pin-made ${[...new Set(made.map((each) => each.mark))].sort().join(',')} -->`] : [];

/** The moves a pull request's description says it carries, by name; none when it has no mark the watch wrote. */
export function carriedBy(body: string | null | undefined): string[] {
  try {
    const names: unknown = JSON.parse(decodeURIComponent(MOVES_MARK.exec(body ?? '')?.[1] ?? ''));
    return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

export { namedMajor };

/** The files a move pins, in order. */
const filesOf = (move: Pick<ReadMove, 'pins'>) => [...new Set(move.pins.map((pin) => pin.file))].sort();

/**
 * The branch of the pull request a move is in: that of the files it writes, so every move of the day at one file is in
 * one pull request, and a move at two files (one chart at two Applications) is whole in one. A move the gate will name
 * `major` is on its files' other branch: the level may hold it, and the rest of its file's moves do not wait for it. A
 * routine update is on a branch of its files' routine updates, so no fix waits for one. A
 * move the pin step makes is grouped by what it writes whole (`writtenBy`): the lockfile, with an image that brings
 * its library there; mise's files; an image's Dockerfiles, with the Node it brings.
 */
export const branchOf = (move: Pick<ReadMove, 'pins' | 'lockfile' | 'name' | 'to'> & Apart): string =>
  pinBranchFor(madeByStep(move) ? writtenBy(move) : filesOf(move), namedMajor(move), isRoutine(move));

/** A move's name as code in a description: no backtick, no line break. */
const code = (text: string) => `\`${text.replace(/[`\r\n]/g, '')}\``;

const counted = (counts: ReadMove['clears']) =>
  SEVERITIES.filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s.toLowerCase()}`)
    .join(', ') || 'nothing';

/** A version as the target writes it, for a pull request's title. */
function versionOf(target: Target): string | undefined {
  switch (target.kind) {
    case 'image':
      return target.tag;
    case 'chart':
    case 'tool':
      return target.version;
    case 'k3s':
      return target.release;
    case 'version':
      return target.versions.length === 1 ? target.versions[0] : undefined;
    case 'unbuilt':
      return undefined;
  }
}

/** A digest written after a pin's tag, as `@sha256:…`. */
const DIGEST_AFTER = new RegExp(`^@${DIGEST_PATTERN}`);

/**
 * The edit a move makes at one pin's line, or why it cannot be written there: what it pins now, as the line writes it
 * (a tag and its digest, or a version), replaced by the target, in the same shape.
 */
export function editAt(
  pin: { file: string; line: number },
  line: string,
  from: string,
  target: Target,
): PinEdit | { reason: string } {
  const at = `${pin.file}:${pin.line}`;
  const tries: { from: string; to: (digested: boolean) => string | undefined }[] = [];
  const tag = splitReference(from).name;
  switch (target.kind) {
    case 'image':
      tries.push({ from: tag, to: (digested) => (digested ? `${target.tag}@${target.digest}` : target.tag) });
      break;
    case 'chart':
      tries.push({ from, to: (digested) => (digested ? undefined : target.version) });
      break;
    case 'k3s':
      // k3s's image tag writes its release's `+` as `-`.
      tries.push({ from, to: (digested) => (digested ? undefined : target.release) });
      tries.push({
        from: from.replace('+', '-'),
        to: (digested) => (digested ? undefined : target.release.replace('+', '-')),
      });
      break;
    case 'version':
      if (target.versions.length === 1 && !from.includes(','))
        tries.push({ from, to: (digested) => (digested ? undefined : target.versions[0]) });
      break;
    default:
      break;
  }
  for (const each of tries) {
    const found = spans(line, each.from, { digestAfter: true });
    if (found.length !== 1) continue;
    const start = found[0] as number;
    const digest = DIGEST_AFTER.exec(line.slice(start + each.from.length))?.[0];
    const written = `${each.from}${digest ?? ''}`;
    // What the guard reads as a word of its own, the same rule: the span with its digest, once on the line.
    if (spans(line, written).length !== 1) continue;
    const to = each.to(digest !== undefined);
    if (to === undefined) return { reason: `${at} pins a digest the target does not name` };
    return { file: pin.file, line: pin.line, from: written, to };
  }
  return { reason: `${at} does not write ${from} once as a word of its own` };
}

/** What the scan's run is, in a sentence. */
const runText = (moves: Moves) => `the scan of run [${moves.run.id}](${moves.run.url})`;
/** The same, to start a sentence. */
const RunText = (moves: Moves) => `T${runText(moves).slice(1)}`;

/** One move a pull request carries, and the edits it makes at its pins. */
export interface Carried {
  move: ReadMove;
  edits: PinEdit[];
}

/** Every edit a pull request makes, in order of file and line, whatever order the day lists its moves in. */
const editsOf = (carried: readonly Carried[]): PinEdit[] =>
  carried.flatMap((each) => each.edits).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

/** How a pull request merges, in its description: by the gate's rule for it, and what is Martin's after. */
function mergesBy(carried: readonly Carried[]): string {
  const majors = carried.filter(({ move }) => namedMajor(move));
  // A routine update clears nothing: its major has no advisory behind it at all.
  const why = majors.every(({ move }) => isRoutine(move))
    ? 'It crosses a major, with no advisory behind it'
    : 'It crosses a major and clears no Critical by Trivy’s own rating';
  const merges = majors.length
    ? `${why}, so the review gate passes it as \`major\` when it is exactly the scan’s moves. The worker adds a \`major\` to the merge queue at Lights-out; at any other level it waits for you: read what the new major changes, then add it to the queue or close it.`
    : 'The review gate passes it as `move` when it is exactly the scan’s moves, which the gate makes itself on main and compares with this pull request, and the worker then adds it to the merge queue once its checks are green and the autonomy level queues a move. If anything differs, its `review` check says what: your approval of its head passes it, and adding it to the queue is yours.';
  // k3s merges as any move; only the cluster's own command applies it.
  const cluster = carried.some(({ move }) => move.lane === 'cluster')
    ? ' k3s moves with your cluster: once this merges, run `make upgrade-cluster`, which moves the local cluster to the new pin and keeps everything in it, and then `scripts/mark-refusals.sh`, which keeps Traefik’s settings as the new k3s has them.'
    : '';
  return `${merges}${cluster}`;
}

/** Whether every move a pull request carries is a routine update: its files' routine updates ride together. */
const allRoutine = (carried: readonly Carried[]) => carried.length > 0 && carried.every(({ move }) => isRoutine(move));

/** What a routine update is, in a description: one sentence, for one move or for several. */
const routineWords = (count: number) =>
  count === 1
    ? 'It is a routine update: a newer release, with no advisory behind it and no deadline.'
    : 'Each is a routine update: a newer release, with no advisory behind it and no deadline.';

/**
 * What each move clears and leaves, and its deadline, as a table after a blank line. A routine update clears nothing
 * and has no deadline, which its description says in a sentence: its row says only what its pins still have open,
 * where they have anything, and the table is left out where no row is left.
 */
function countsTable(moves: readonly ReadMove[]): string[] {
  const found = moves.filter((move) => !isRoutine(move));
  const left = moves.filter((move) => isRoutine(move) && SEVERITIES.some((s) => move.leaves[s]));
  return [
    ...(found.length
      ? [
          '',
          '| Move | Clears | Leaves on the same pins | Deadline |',
          '| --- | --- | --- | --- |',
          ...found.map(
            (move) =>
              `| ${code(move.name)} | ${counted(move.clears)} | ${counted(move.leaves)} | ${move.deadline ?? 'none'} |`,
          ),
        ]
      : []),
    ...(left.length
      ? [
          '',
          '| Routine update | Leaves on the same pins |',
          '| --- | --- |',
          ...left.map((move) => `| ${code(move.name)} | ${counted(move.leaves)} |`),
        ]
      : []),
  ];
}

/** A pull request's description, the factory's own. */
export function pullBody(carried: readonly Carried[], moves: Moves): string {
  const sorted = [...carried].sort((a, b) => (a.move.name < b.move.name ? -1 : a.move.name > b.move.name ? 1 : 0));
  const edits = editsOf(sorted);
  const one = sorted.length === 1 ? sorted[0]?.move : undefined;
  const routine = allRoutine(sorted);
  const what = one
    ? `moves ${code(one.name)} from ${code(one.from)} to ${code(one.to)}`
    : `makes ${sorted.length} of the day’s ${routine ? 'routine updates' : 'moves'}`;
  const lines = [
    `The factory's pin watch ${what}, as ${runText(moves)} ${routine ? 'lists' : 'found'} (judged ${moves.file?.judged ?? 'then'}).${routine ? ` ${routineWords(sorted.length)}` : ''} It changes nothing but the version or digest at each pin.`,
    '',
    '| Move | Pin | Before | After |',
    '| --- | --- | --- | --- |',
    ...sorted.flatMap(({ move, edits: own }) =>
      own.map(
        (edit) =>
          `| ${code(move.name)} | ${code(`${edit.file}:${edit.line}`)} | ${code(edit.from)} | ${code(edit.to)} |`,
      ),
    ),
    ...countsTable(sorted.map(({ move }) => move)),
    '',
    mergesBy(sorted),
    '',
    `<!-- factory: pin-edits ${editsHash(edits)} -->`,
    `<!-- factory: pin-moves ${encodeURIComponent(JSON.stringify(sorted.map(({ move }) => move.name)))} -->`,
    ...madeLine(madeOf(sorted)),
  ];
  return `${lines.join('\n')}\n`;
}

/** Why a move the pin step makes is an issue: the step refused it, in the scan's run. */
const STEP_REFUSED = 'the pin step could not make it on the commit the scan read';

/**
 * The kinds of refusal the pin step gives a move (apps/runner/src/pins.ts), by what will make the move go: a release
 * younger than the minimum age, one published with weaker provenance than the release before, an install script not
 * allowed, a copy only an override would move, a release mise could not lock; and anything else.
 */
export type RefusalKind = 'young' | 'provenance' | 'script' | 'override' | 'lock' | 'other';

/**
 * The kind of a refusal, from the step's one line of it (`MadeGroup.refused`), which carries pnpm's or mise's own
 * reason or the step's: read for the words each tool and the step use, and never repeated where the public reads.
 *
 * - `provenance`: pnpm's `High-risk trust downgrade … (possible package takeover)`, its `trustPolicy`.
 * - `override`: the step's own, of a copy its parents hold below the target: `… so it needs an override in
 *   pnpm-workspace.yaml`.
 * - `script`: pnpm's `… has to be built but the build scripts were ignored`, and its `allowBuilds`.
 * - `young`: pnpm's `… does not meet the minimumReleaseAge constraint: … within the minimumReleaseAge cutoff`, and
 *   the step's own of Node and of a tool, `… within mise.toml's minimum_release_age`.
 * - `lock`: anything else `mise lock` refused, which the step says as `mise refused …`.
 *
 * Each is a phrase with a space in it or a setting's name in capitals, which no package's name can be, so a package
 * named for one of them reads as `other`, which claims nothing.
 */
export function refusalKind(reason: string): RefusalKind {
  if (/\btrust downgrade\b|\bERR_PNPM_TRUST_DOWNGRADE\b/.test(reason)) return 'provenance';
  if (/ needs an override in pnpm-workspace\.yaml/.test(reason)) return 'override';
  if (/ build scripts were ignored\b| under allowBuilds\b|\bERR_PNPM_IGNORED_BUILDS\b/.test(reason)) return 'script';
  if (/\bminimumReleaseAge (?:constraint|cutoff)\b| within mise\.toml's minimum_release_age\b/.test(reason))
    return 'young';
  if (/^mise refused /.test(reason)) return 'lock';
  return 'other';
}

/** What the scan's pin step could not do, and what will make the move go, by the kind of its refusal. */
const REFUSED: Record<RefusalKind, string> = {
  young:
    'The scan’s pin step could not make it on the commit it read: the release is younger than the minimum age this repository gives a release before it takes one. Nothing is asked of you: the watch makes the move on a later day’s scan, once the release is old enough.',
  provenance:
    'The scan’s pin step could not make it on the commit it read: pnpm refuses the release, which was published with weaker provenance than the release before it. The watch makes the move once a later release is published with the provenance the earlier ones had. This release goes only with an exception for it in `pnpm-workspace.yaml`, with its reason, and that file is yours.',
  script:
    'The scan’s pin step could not make it on the commit it read: the release has an install script this repository does not allow. It goes only with an entry for it in `pnpm-workspace.yaml`, with its reason, and that file is yours; or with a later release that needs none.',
  override:
    'The scan’s pin step could not make it on the commit it read: a copy of it stays below the target, because what depends on it admits nothing newer. It goes with a later release of what depends on it, which the watch then makes; or with an override for that copy in `pnpm-workspace.yaml`, with its reason, and that file is yours.',
  lock: 'The scan’s pin step could not make it on the commit it read: mise could not lock the release. The watch makes the move once a scan can, on a later run or a later release; or move it by hand, and the scan’s next run sees it.',
  other:
    'The scan’s pin step could not make it on the commit it read. The watch makes the move once a scan can; or move it by hand, and the scan’s next run sees it.',
};

/** Why a move the watch made before is left unmade: its merge was undone on `main`. */
const REVERTED = 'its merge was undone on main';
/** Why a move the pin step makes waits beside one undone on `main`: the step makes their files whole. */
const WITH_REVERTED = 'a move made with it was undone on main';
/** Why a move waits whose branch a pull request of someone else's stands on. */
const BRANCH_HELD = 'a pull request the App did not open stands on its branch';
/** Why a move waits whose pull request GitHub would not open. */
const OPEN_REFUSED = 'GitHub refused its pull request';

/** What each of those asks of Martin, for the move's issue. */
const WAITS: Record<string, string> = {
  [REVERTED]:
    'The factory made this move, and its merge was then undone on `main`: the pin is back at what it moved from. The watch leaves it unmade until its target changes. To have it made as it is, put its merge back on `main`, or move it in a pull request of your own.',
  [WITH_REVERTED]:
    'The scan’s pin step makes it together with a move whose merge was undone on `main`, in the same files, and the watch commits what the step made whole or not at all: it waits until that move’s target changes, or its merge is put back on `main`. Or move it in a pull request of your own.',
  [BRANCH_HELD]:
    'A pull request the App did not open is open from the branch the watch makes this move on, and the watch writes no branch another’s pull request stands on. Close that pull request, and the watch makes the move on its next pass.',
  [OPEN_REFUSED]:
    'The watch committed the move to its branch, and GitHub refused the pull request from it. The watch tries again each pass; what GitHub said is in the worker’s log and its refusal.',
};

/** Why the App cannot write a move, and what to do instead, for its issue. */
function cannotWrite(move: ReadMove, why?: string, kind: RefusalKind = 'other'): string {
  if (why === STEP_REFUSED) return REFUSED[kind];
  const waits = why === undefined ? undefined : WAITS[why];
  if (waits) return waits;
  if (why)
    return `The watch cannot write it on its pins' lines (${why}): move it by hand, and the scan's next run sees it.`;
  if (move.lane === 'none')
    return 'Its line is no longer built: nothing on this line will bring the fix. Move the pin to a line its publisher builds, and the scan reads it from there.';
  if (isRoutine(move) && move.pins.some((pin) => pin.file.startsWith('.github/')))
    return 'A workflow pins it, and the App writes no workflow: move it in a pull request of your own, when you choose to. Nothing is due.';
  if (move.pins.some((pin) => pin.file.startsWith('.github/')))
    return 'A workflow pins it, and the App writes no workflow: move it in a pull request of your own.';
  return 'It needs more than its pins’ lines written, which no pull request of the App’s makes: move it in a pull request of your own.';
}

/** The key an issue is found again by: the move's name, or for a lockfile's, its mark, which names no package. */
function issueKey(move: ReadMove): string {
  if (move.lockfile) return `lockfile-${move.mark ?? move.index}`;
  return segmentOf(move.name);
}

/**
 * An issue's title and description, and the target it is written for (`pin-target`): for a lockfile's move none, which
 * the public list withholds, but for a routine update the pin step refused, whose issue names its release, so one
 * Martin closed opens again for a later release.
 */
export function issueOf(
  move: ReadMove,
  moves: Moves,
  why?: string,
  kind?: RefusalKind,
): { title: string; body: string; key: string; target: string } {
  const key = issueKey(move);
  const name = move.lockfile ? `${move.name} (${key.slice('lockfile-'.length)})` : move.name;
  const routine = isRoutine(move);
  // A lockfile's package and versions are the scan's alone: its alerts name a finding's, and a routine update has none.
  const to = move.lockfile
    ? routine
      ? 'a newer release'
      : 'the version its alerts name'
    : move.to || 'a line that is built';
  const title =
    move.lane === 'none'
      ? `Move ${name.replace(/`/g, '')} off a line no longer built`
      : `Move ${name.replace(/`/g, '')} to ${to}`;
  const pins = move.lockfile
    ? [...new Set(move.pins.map((pin) => pin.file))].map((file) => `- ${code(file)}`)
    : move.pins.map((pin) => `- ${code(`${pin.file}:${pin.line}`)}, pinning ${code(move.from)}`);
  // A routine update the step refused is named, its package and the release: no finding is behind it to give away, as
  // its pull request's title would have named it. What its pins have open is then left out: that is a finding's.
  const named = routine && move.lockfile && why === STEP_REFUSED ? move.withheld : undefined;
  const release = named && readTarget(named.to);
  const releases = (release?.kind === 'version' ? release.versions : [named?.to ?? '']).map(code).join(' and ');
  const target = named ? named.to : move.to;
  // Where the watch makes pull requests it is the watch that cannot make this one; where it makes none, the factory.
  const maker = ISSUE_REPOS.includes(moves.repository) ? 'the factory' : "the factory's pin watch";
  const body = [
    `<!-- factory: pin-issue ${key} -->`,
    `<!-- factory: pin-target ${targetMark(target)} -->`,
    `${RunText(moves)} lists a move ${maker} ${why === REVERTED || why === WITH_REVERTED ? 'leaves unmade' : 'cannot make with a pull request of its own'}: ${code(move.name)}${move.lockfile ? '' : ` from ${code(move.from)}`} to ${move.lockfile ? to : code(to)}.`,
    '',
    cannotWrite(move, why, kind),
    '',
    '**Pins**',
    '',
    ...pins,
    '',
    ...(routine
      ? [
          named
            ? `**A routine update** ${code(named.package)} to ${releases}: a newer release, with no advisory behind it and no deadline.`
            : `**A routine update** A newer release, with no advisory behind it and no deadline${SEVERITIES.some((s) => move.leaves[s]) ? `; its pins have ${counted(move.leaves)} open that it leaves` : ''}.`,
        ]
      : [
          `**Clears** ${counted(move.clears)}; leaves ${counted(move.leaves)} on the same pins.`,
          '',
          `**Deadline** ${move.deadline ?? 'none'}.`,
        ]),
    '',
    'The watch keeps this issue to the scan: it updates it as the move changes, and closes it once the scan no longer lists the move.',
    '',
  ].join('\n');
  return { title: title.slice(0, 256), body, key, target };
}

/**
 * A pull request's title: for one move, what it moves and to what; for several, how many pins and in which file. Short
 * of the hundred characters a title on `main` may be (scripts/commit-msg.ts) for any name or path the factory has.
 */
export function pullTitle(carried: readonly Carried[]): string {
  const [first, ...rest] = carried;
  if (first && !rest.length) {
    const target = readTarget(first.move.to);
    return pinTitle(first.move.name, (target && versionOf(target)) ?? first.move.to);
  }
  const files = [...new Set(carried.flatMap(({ move }) => filesOf(move)))].sort();
  const pins = carried.reduce((sum, each) => sum + each.edits.length, 0);
  const more = files.length > 1 ? ` and ${files.length - 1} more` : '';
  return `chore(pin): move ${pins} pins in ${files[0] ?? ''}${more}`.slice(0, 256);
}

/** What a pull request of moves the pin step made commits: the files it wrote, whole, and its record of them. */
export interface Written {
  made: MadeGroup;
  files: { path: string; text: string }[];
}

/** The mark of a pull request whose files the pin step wrote: their paths and a digest of each. */
const writtenHash = (files: readonly { path: string; text: string }[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .map((f) => [f.path, createHash('sha256').update(f.text).digest('hex')]),
      ),
    )
    .digest('hex');

/** A name as the diff writes it: no backtick, no line break. */
const plain = (text: string) => text.replace(/[`\r\n]/g, '');

/**
 * The title of a pull request of moves the pin step made, by what its diff shows and nothing the scan withholds: the
 * package or tool it moves, or how many, in which file. A lockfile's package's versions are left to the diff.
 */
export function madeTitle({ made }: Written): string {
  const names = [...new Set(made.steps.map((step) => step.name))];
  const files = `${made.files[0] ?? ''}${made.files.length > 1 ? ` and ${made.files.length - 1} more` : ''}`;
  const [first] = made.steps;
  if (names.length === 1 && first) {
    if (first.ecosystem === 'npm') return `chore(pin): move ${plain(first.name)} in ${files}`.slice(0, 256);
    // An image's tag, without its digest, as an edit's title names it.
    const to = [...new Set(made.steps.flatMap((step) => step.after.map((each) => each.split('@')[0] ?? each)))].join(
      ' and ',
    );
    return pinTitle(first.name, to);
  }
  const what = made.steps.every((step) => step.ecosystem === 'npm') ? 'packages' : 'pins';
  return `chore(pin): move ${names.length} ${what} in ${files}`.slice(0, 256);
}

/**
 * The description of a pull request of moves the pin step made: what each moves, before and after, as its diff shows
 * it; for a move the scan names in public (what mise pins), what it clears and its deadline, as for an edit's; for a
 * lockfile's, nothing more, since what the scan found in a package is the scan's alone. Routine updates, which ride
 * apart, are said to be so: there is nothing the scan found behind one.
 */
export function madeBody(carried: readonly Carried[], written: Written, moves: Moves): string {
  const { made } = written;
  const names = (values: readonly string[]) => values.map((value) => code(value)).join(', ') || '–';
  const open = carried.filter(({ move }) => !move.lockfile);
  const routine = allRoutine(carried);
  const kind = routine ? 'routine updates' : 'moves';
  const lines = [
    `The factory's pin watch makes ${carried.length === 1 ? `one of the day’s ${kind}` : `${carried.length} of the day’s ${kind}`} in ${made.files.map((file) => code(file)).join(' and ')}, as ${runText(moves)} ${routine ? 'lists' : 'found'} (judged ${moves.file?.judged ?? 'then'}).${routine ? ` ${routineWords(carried.length)}` : ''} The scan made ${carried.length === 1 ? 'it' : 'them'} on the commit it read, with the pin step and the pnpm and mise this repository pins, and the review gate makes ${carried.length === 1 ? 'it' : 'them'} again on main and compares, byte for byte. It changes nothing but the files they write.`,
    '',
    '| Moves | Before | After |',
    '| --- | --- | --- |',
    ...made.steps.map((step) => `| ${code(step.name)} | ${names(step.before)} | ${names(step.after)} |`),
    ...brought(made),
    ...countsTable(open.map(({ move }) => move)),
    '',
    mergesBy(carried),
    '',
    `<!-- factory: pin-edits ${writtenHash(written.files)} -->`,
    `<!-- factory: pin-moves ${encodeURIComponent(JSON.stringify(carried.map(({ move }) => move.name)))} -->`,
    ...madeLine(madeOf(carried, written)),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * What an image's move brought with it, in a description: its library, at the release the image's tag names, in the
 * lockfile and the manifests that name it. The diff shows the versions.
 */
function brought(made: MadeGroup): string[] {
  return made.steps.flatMap((step) => {
    const library = step.ecosystem === 'docker' ? libraryOf(step.name) : undefined;
    if (!library) return [];
    return [
      '',
      `${code(step.name)} is one release with its library, ${library.map((name) => code(name)).join(', ')}: the pin step moves each copy of it in the lockfile, and each manifest’s range, to the release its tag names, in the same change.`,
    ];
  });
}

/** The title of one move's pull request, from its name and the version it moves to. */
export const pinTitle = (name: string, to: string): string =>
  `chore(pin): move ${name.replace(/[`\r\n]/g, '')} to ${to}`.slice(0, 256);

/**
 * The watch's actions where it keeps issues alone: the four on issues, and each that would make or change a branch,
 * a commit or a pull request replaced by one that throws, so a pass there can ask GitHub for none, whatever it does.
 */
function issuesOnly(actions: PinWatchDependencies['actions'], repo: string): PinWatchDependencies['actions'] {
  const never = (what: string) => async (): Promise<never> => {
    throw new Error(`The pin watch keeps issues alone in ${repo}: it does not ${what} there.`);
  };
  return {
    dryRun: actions.dryRun,
    openIssue: (...args) => actions.openIssue(...args),
    updateIssue: (...args) => actions.updateIssue(...args),
    closeIssue: (...args) => actions.closeIssue(...args),
    reopenIssue: (...args) => actions.reopenIssue(...args),
    commitPins: never('commit'),
    openPullRequest: never('open a pull request'),
    updatePullRequest: never('update a pull request'),
    addLabels: never('label a pull request'),
    closePullRequest: never('close a pull request'),
  };
}

/**
 * Watches a repository's moves. In this one (`PIN_REPOS`) it keeps one pull request for each file's, or one issue for a
 * move. In the app's (`ISSUE_REPOS`), whose line makes its moves, it keeps the issues alone: no move is its to write
 * there, so it reads no branch, file or pull request, and its actions are the four on issues (`issuesOnly`). Any
 * other repository is refused.
 */
export function pinWatch(deps: PinWatchDependencies, repo: string): Watch {
  const { github, reads, recorder, log, now = Date.now, source = treeSource(github), only = [], heads } = deps;
  /** Whether the watch makes this repository's moves: decided here, from the lists above, and by nothing passed in. */
  const makes = PIN_REPOS.includes(repo);
  if (!makes && !ISSUE_REPOS.includes(repo))
    throw new Error(`The pin watch does not move ${repo}'s pins, or keep its issues.`);
  const actions = makes ? deps.actions : issuesOnly(deps.actions, repo);
  let last: number | undefined;
  /** The refusals kept, by the branch and the words, so each is recorded once a run; emptied as the run changes. */
  const kept = new Set<string>();
  /** What each move's waiting said, so it is said once a run; emptied as the run changes. */
  const said = new Set<string>();
  let keptFor: number | undefined;
  /**
   * A dry run's pull requests and issues, which GitHub never has: what it last recorded for each branch and issue, so
   * a pass records each once, and again only when what it would write changes.
   */
  const recorded = new Map<string, string>();

  const say = (key: string, about: object, message: string) => {
    if (said.has(key)) return;
    said.add(key);
    log.info({ repo, ...about }, message);
  };

  const refused = async (run: number, branch: string, error: BranchRefused | PatchRefused, number: number | null) => {
    const key = `${run} ${branch} ${error.message}`;
    if (kept.has(key)) return;
    kept.add(key);
    log.warn({ repo, branch, err: error }, 'the pin guard refused a pin move');
    if (!recorder) return;
    await recorder
      .record({
        repo,
        number,
        mechanism: 'github-guard',
        cause: error instanceof BranchRefused ? 'branch' : 'protected',
        action: `Commit a pin move to ${branch} in ${repo}`,
        output: error.message,
      })
      .catch((err: unknown) => log.error({ repo, branch, err }, 'could not keep a refusal'));
  };

  /**
   * A file's lines at a commit, from git's tree as the guard reads it, or undefined for one that is not an ordinary
   * file there: the watch's edit and the guard's reading of it are of the same file.
   */
  const linesAt = async (path: string, ref: string): Promise<string[] | undefined> => {
    try {
      const file = await source.file(repo, ref, path);
      if (!file || (file.mode !== '100644' && file.mode !== '100755')) return undefined;
      return file.text.split('\n');
    } catch (error) {
      if (error instanceof PatchRefused) return undefined;
      throw error;
    }
  };

  /** The commit a branch is at, or undefined when there is none. */
  const branchAt = async (branch: string): Promise<string | undefined> => {
    try {
      const { body } = await github.poll(repo, `/repos/${repo}/git/ref/heads/${branch}`, BRANCH);
      return body.object.sha;
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') return undefined;
      throw error;
    }
  };

  /**
   * Whether a pin branch's head is the commit the watch would write now, though this worker did not write it (it has
   * started since): exactly what the guard gives back for the day's moves on main's head (`pinChanges`), as
   * `own-commit.ts` reads a head. Whatever the guard refuses is written again.
   */
  const alreadyWritten = async (at: string, commit: PinCommit): Promise<boolean> => {
    let writes: { path: string; contents: Uint8Array }[];
    try {
      writes = await pinChanges(repo, commit, source);
    } catch (error) {
      if (error instanceof BranchRefused || error instanceof PatchRefused) return false;
      if (error instanceof GitHubError && error.kind === 'conflict') return false;
      throw error;
    }
    const whole = writes.map((write) => ({ path: write.path, text: TEXT.decode(write.contents) }));
    return isOwnCommit(github, source, repo, commit.base, at, whole);
  };

  /**
   * Who closed an issue or pull request: Martin (`MARTIN`, by his id), whose close alone holds a target back; the App
   * itself; or anyone else, whose close holds nothing.
   */
  const closedBy = async (number: number): Promise<'martin' | 'app' | 'other'> => {
    const { body } = await github.poll(repo, `/repos/${repo}/issues/${number}`, CLOSED_BY);
    if (body.closed_by?.id === MARTIN) return 'martin';
    return body.closed_by?.login === APP_LOGIN ? 'app' : 'other';
  };

  /**
   * The open pull requests from this repository's pin branches: the App's own, and anyone else's, which the watch
   * never writes under (`theirs`).
   */
  const openPulls = async (): Promise<{ own: Pull[]; theirs: Pull[] }> => {
    const own: Pull[] = [];
    const theirs: Pull[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const { body } = await github.poll(repo, `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, PULLS);
      for (const p of body) {
        if (p.head.repo?.full_name !== repo || !p.head.ref.startsWith(PIN_PREFIX)) continue;
        (p.user?.login === APP_LOGIN ? own : theirs).push(p);
      }
      if (body.length < 100) return { own, theirs };
    }
    throw new GitHubError('malformed', `${repo} has more open pull requests than the pin watch reads.`);
  };

  /** The App's closed pull requests from a branch of this repository, the newest hundred, merged or not. */
  const closedOn = async (branch: string): Promise<Pull[]> => {
    const [owner] = repo.split('/');
    const { body } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=closed&per_page=100&head=${owner}:${encodeURIComponent(branch)}`,
      PULLS,
    );
    return body.filter(
      (pull) => pull.user?.login === APP_LOGIN && pull.head.repo?.full_name === repo && pull.head.ref === branch,
    );
  };

  /**
   * Whether Martin closed, without merging it, a pull request of the App's on this branch that made the same edits.
   * One that anyone else closed holds nothing: the watch opens the move again, and says who closed it.
   */
  const closedByMartin = async (branch: string, edits: string): Promise<boolean> => {
    for (const pull of await closedOn(branch)) {
      if (pull.merged_at || EDITS_MARK.exec(pull.body ?? '')?.[1] !== edits) continue;
      const by = await closedBy(pull.number);
      if (by === 'martin') return true;
      if (by === 'other')
        say(
          `closed by another ${pull.number}`,
          { branch, number: pull.number },
          'someone but Martin closed this pin pull request: the watch opens its move again',
        );
    }
    return false;
  };

  /** Whether a commit is in `main`'s history at a head: GitHub's merge base of the two is the commit itself. */
  const inMain = async (commit: string, head: string): Promise<boolean> => {
    try {
      const { body } = await github.poll(repo, `/repos/${repo}/compare/${commit}...${head}?per_page=1`, MERGE_BASE);
      return body.merge_base_commit.sha === commit;
    } catch (error) {
      // A commit GitHub no longer has is in nobody's history.
      if (error instanceof GitHubError && error.kind === 'not-found') return false;
      throw error;
    }
  };

  /**
   * Which of the moves a branch's pull request would make today were undone on `main`, each with the merged pull
   * request that made it: a merged pull request of the App's from the branch names the very move (`MADE_MARK`), and
   * its merge is still in `main`'s history. That the watch can make the move again at all says `main` holds what it
   * moved from, so `main` took the move and someone put it back. Read from GitHub, so a restart finds the same.
   */
  const undoneOn = async (branch: string, marks: readonly string[], head: string): Promise<Map<string, number>> => {
    const undone = new Map<string, number>();
    for (const pull of await closedOn(branch)) {
      if (!pull.merged_at || !pull.merge_commit_sha) continue;
      const made = (MADE_MARK.exec(pull.body ?? '')?.[1] ?? '').split(',');
      const again = marks.filter((mark) => made.includes(mark) && !undone.has(mark));
      if (!again.length || !(await inMain(pull.merge_commit_sha, head))) continue;
      for (const mark of again) undone.set(mark, pull.number);
    }
    return undone;
  };

  const pinIssues = async (): Promise<Map<string, Issue>> => {
    const out = new Map<string, Issue>();
    for (let page = 1; page <= PAGES; page++) {
      const { body } = await github.poll(
        repo,
        `/repos/${repo}/issues?state=all&labels=${PIN_LABEL}&per_page=100&sort=created&direction=asc&page=${page}`,
        ISSUES,
      );
      for (const issue of body) {
        if (issue.pull_request !== undefined || issue.user?.login !== APP_LOGIN) continue;
        const key = ISSUE_MARK.exec(issue.body ?? '')?.[1];
        // The newest of the App's for a key, open before closed.
        const seen = key ? out.get(key) : undefined;
        if (key && (seen?.state !== 'open' || issue.state === 'open')) out.set(key, issue);
      }
      if (body.length < 100) return out;
    }
    throw new GitHubError('malformed', `${repo} has more pin issues than the pin watch reads.`);
  };

  // The moves it was told to take: nothing else of the App's is closed as gone.
  const every = only === '*';
  const named = new Set(every ? [] : only);
  let toldNothing = false;

  return async () => {
    if (last !== undefined && now() - last < PASS_MS) return;
    if (!every && !named.size) {
      if (!toldNothing) log.info({ repo }, 'the pin watch was told no move (PIN_WATCH_ONLY): it takes none');
      toldNothing = true;
      last = now();
      return;
    }
    const read = await reads.moves(repo);
    const taken = every ? read.moves : read.moves.filter((move) => named.has(move.name));
    const day: Moves = { ...read, moves: taken };
    // What a gone move's issue may be closed by: a named move's key, unless a move it was not told to take has that key
    // too (a name folds to its key, so another name can share it), and every taken move's.
    const others = new Set(read.moves.filter((move) => !taken.includes(move)).map(issueKey));
    const ownIssues = new Set([
      ...[...named].map((name) => segmentOf(name)).filter((key) => !others.has(key)),
      ...taken.map(issueKey),
    ]);
    if (!day.file) {
      say(
        `no file ${day.run.id}`,
        { run: day.run.id },
        'the scan wrote no moves: the pin watch waits for a run that did',
      );
      last = now();
      return;
    }
    const [{ own: open, theirs }, issues] = await Promise.all([
      makes ? openPulls() : { own: [], theirs: [] },
      pinIssues(),
    ]);
    // Where it keeps issues alone no move is written, so nothing is read of main.
    const head = makes ? await source.head(repo) : '';
    const scanned = day.run.headSha;
    const run = day.run.id;
    if (keptFor !== run) {
      kept.clear();
      said.clear();
      keptFor = run;
    }
    say(
      `scope ${run}`,
      {
        only: every ? '*' : [...named],
        taken: taken.length,
        leftAlone: read.moves.length - taken.length,
        unknown: [...named].filter((name) => !read.moves.some((move) => move.name === name)),
      },
      'the pin watch takes the moves it was told to (PIN_WATCH_ONLY), and leaves the rest alone',
    );
    /** Whether the next poll reads the day again rather than wait the hour: main moved while a move was written. */
    let again = false;

    // Two moves that name one line are both refused: neither is the one move of that pin. Read over every move of the
    // day, taken or not: a move named alone is still refused beside a rival it was not told.
    const writable = (m: ReadMove) => makes && PULL_LANES.has(m.lane);
    // A move the pin step makes is made as one step on its files, whatever line its pin names (two of the scan's
    // moves at one tool's entry are one tool's move): it is never one of two edits at a line.
    const byPlace = new Map<string, ReadMove[]>();
    for (const move of read.moves.filter((m) => writable(m) && !madeByStep(m)))
      for (const pin of move.pins) {
        const key = `${pin.file}:${pin.line}`;
        byPlace.set(key, [...(byPlace.get(key) ?? []), move]);
      }

    /** The branches today's moves keep: their pull requests stay. */
    const keep = new Set<string>();
    /** The issues today's moves keep, each with what it says. */
    const wanted = new Map<string, { title: string; body: string; target: string }>();
    const want = (move: ReadMove, why?: string, kind?: RefusalKind) => {
      const issue = issueOf(move, day, why, kind);
      wanted.set(issue.key, { title: issue.title, body: issue.body, target: issue.target });
    };

    for (const move of day.moves) if (ISSUE_LANES.has(move.lane)) want(move);

    // Each move the watch can write today, with its edits, by the branch of the pull request it is in; and those the
    // pin step makes, which the scan made, by theirs.
    const groups = new Map<string, Carried[]>();
    const stepped = new Map<string, ReadMove[]>();
    for (const move of day.moves.filter(writable)) {
      const branch = branchOf(move);
      if (madeByStep(move)) {
        stepped.set(branch, [...(stepped.get(branch) ?? []), move]);
        continue;
      }
      const existing = open.find((p) => p.head.ref === branch);
      const target = readTarget(move.to);
      if (
        !target ||
        (target.kind !== 'image' && target.kind !== 'chart' && target.kind !== 'k3s' && target.kind !== 'version')
      ) {
        want(move, `its target, ${move.to || 'none'}, is not a version or digest a pin's line writes`);
        continue;
      }
      const twice = [...new Set(move.pins.flatMap((pin) => byPlace.get(`${pin.file}:${pin.line}`) ?? []))];
      if (twice.length > 1) {
        keep.add(branch);
        const error = new PatchRefused(
          'protected',
          `Moves ${twice.map((m) => m.name).join(' and ')} name one line: neither is the one move of that pin.`,
        );
        await refused(run, branch, error, existing?.number ?? null);
        continue;
      }
      // The edits, from each pin's line at main's head, which must still be the line the scan read.
      const edits: PinEdit[] = [];
      let why: string | undefined;
      let waits = false;
      for (const file of filesOf(move)) {
        const [now, then] = await Promise.all([linesAt(file, head), linesAt(file, scanned)]);
        if (!now || !then) {
          why = `${file} is not a file the watch can read`;
          break;
        }
        for (const pin of move.pins.filter((each) => each.file === file)) {
          const line = now[pin.line - 1];
          if (line === undefined || line !== then[pin.line - 1]) {
            waits = true;
            break;
          }
          const edit = editAt(pin, line, move.from, target);
          if ('reason' in edit) {
            why = edit.reason;
            break;
          }
          edits.push(edit);
        }
        if (why || waits) break;
      }
      if (waits) {
        keep.add(branch);
        say(
          `waits ${run} ${move.name} ${head}`,
          { move: move.name, branch, head },
          'a pin’s line has changed since the scan: the move waits for the next',
        );
        continue;
      }
      if (why) {
        want(move, why);
        continue;
      }
      groups.set(branch, [...(groups.get(branch) ?? []), { move, edits }]);
    }

    // The moves the pin step makes: what the scan made of each group, on the commit it read, committed whole once each
    // file it wrote is the same at main's head. A move the step refused is the one thing of its group that waits, with
    // an issue that says so, and which kind of refusal it was, in the watch's words; the step's own are logged here,
    // where the public cannot read.
    // A group is made whole, its files written for every move in it, so a move told takes its group's others with it:
    // the scan's pins job makes every group, whatever the watch is told, and the gate makes the group again whole.
    const writtenOf = new Map<string, Written>();
    for (const [branch, told] of stepped) {
      const [first] = told;
      if (!first) continue;
      const moves = read.moves.filter((move) => writable(move) && madeByStep(move) && branchOf(move) === branch);
      const made = day.made?.groups.find((group) => groupKey(group) === groupKey(groupOf(first)));
      if (!made) {
        keep.add(branch);
        say(
          `unmade ${run} ${branch}`,
          { branch, moves: moves.map((move) => move.index) },
          'the scan made none of these moves with the pin step: they wait for a run that does',
        );
        continue;
      }
      for (const { move: index, reason } of made.refused) {
        const move = moves.find((each) => each.index === index);
        if (!move) continue;
        // Its issue only for a move told: the issue of one not told is never opened, updated or closed.
        if (told.includes(move)) want(move, STEP_REFUSED, refusalKind(reason));
        if (!said.has(`refused ${run} ${index}`)) {
          said.add(`refused ${run} ${index}`);
          log.warn(
            { repo, move: index, mark: move.mark, reason },
            'the scan’s pin step could not make a move: it waits',
          );
        }
      }
      const taken = moves.map((move) => move.index).filter((index) => !made.refused.some((r) => r.move === index));
      if (JSON.stringify(taken) !== JSON.stringify(made.moves)) {
        keep.add(branch);
        say(
          `unlike ${run} ${branch}`,
          { branch, taken, made: made.moves },
          'the scan made other moves here than the watch takes: they wait for a run that made these',
        );
        continue;
      }
      if (!made.moves.length) continue;
      if (!made.changed.length) {
        say(`empty ${run} ${branch}`, { branch }, 'the scan’s pin step wrote nothing for these moves: main has them');
        continue;
      }
      // What the step wrote is made on the files of the commit it read: each must be the same at main's head.
      let same = true;
      for (const file of made.changed) {
        const [now, then] = await Promise.all([
          source.file(repo, head, file.path),
          source.file(repo, scanned, file.path),
        ]);
        if (!now || !then || now.text !== then.text) same = false;
      }
      if (!same) {
        keep.add(branch);
        say(
          `waits ${run} ${branch} ${head}`,
          { branch, head },
          'a file the scan’s pin step wrote has changed since: its moves wait for the next scan',
        );
        continue;
      }
      const carried = made.moves
        .flatMap((index) => moves.filter((move) => move.index === index))
        .map((move) => ({
          move,
          edits: [],
        }));
      groups.set(branch, carried);
      writtenOf.set(branch, { made, files: made.changed });
    }

    /** An issue for each move of a group the watch was told to take, saying why the group waits. */
    const wantAll = (carried: readonly Carried[], why: string) => {
      for (const { move } of carried) if (day.moves.includes(move)) want(move, why);
    };

    // A move whose merge was undone on main is left unmade, said once and as its issue; the rest of its files' moves
    // go on, but for a group the pin step made, which is committed whole or not at all.
    for (const [branch, carried] of [...groups]) {
      const written = writtenOf.get(branch);
      const made = madeOf(carried, written);
      const undone = await undoneOn(
        branch,
        made.map((each) => each.mark),
        head,
      );
      if (!undone.size) continue;
      const left = new Set(made.filter((each) => undone.has(each.mark)).map((each) => each.move));
      for (const { move } of carried.filter((each) => left.has(each.move.index))) {
        const merged = undone.get(made.find((each) => each.move === move.index && undone.has(each.mark))?.mark ?? '');
        if (day.moves.includes(move)) want(move, REVERTED);
        say(
          `undone ${move.lockfile ? (move.mark ?? move.index) : move.name} ${move.to}`,
          { move: move.lockfile ? move.index : move.name, branch, merged },
          'this move’s merge was undone on main: the watch leaves it unmade until its target changes',
        );
      }
      const rest = carried.filter((each) => !left.has(each.move.index));
      if (written) wantAll(rest, WITH_REVERTED);
      if (written || !rest.length) groups.delete(branch);
      else groups.set(branch, rest);
    }

    for (const [branch, carried] of groups) {
      keep.add(branch);
      const existing = open.find((p) => p.head.ref === branch);
      const written = writtenOf.get(branch);
      const edits = editsOf(carried);
      const hash = written ? writtenHash(written.files) : editsHash(edits);
      const title = written ? madeTitle(written) : pullTitle(carried);
      const body = written ? madeBody(carried, written, day) : pullBody(carried, day);
      const fingerprint = `${title}\n${hash}`;
      if (!existing && actions.dryRun && recorded.get(branch) === fingerprint) continue;
      /** Whether its branch already holds these edits: only its words, and a conflict with main, are then left. */
      const holds = EDITS_MARK.exec(existing?.body ?? '')?.[1] === hash;
      /** The commit the watch writes for these moves: on main's head, through the guard. */
      const asked: PinCommit = {
        branch,
        base: head,
        scanned,
        message: title,
        pins: edits,
        ...(written ? { files: written.files } : {}),
      };
      if (existing) {
        if (!existing.labels.some((l) => l.name === PIN_LABEL))
          await actions.addLabels(repo, existing.number, [PIN_LABEL]);
        // Its branch at any commit but the one the watch wrote (moved by anyone, or not yet written by this worker): the
        // watch writes its own again, and its queue adds nothing meanwhile.
        // Read from the branch itself, as GitHub's list of pull requests may name a head a push since has moved.
        const at = heads === undefined ? undefined : await branchAt(branch);
        let ours = heads === undefined || at === heads.get(repo, branch);
        // A worker that has written nothing to it since it started takes, as its own, a head that is already the commit
        // it would write for the edits its description names: a restart costs the pull request no new head, and no
        // round of its checks. One this worker wrote, moved since, is not taken back however it looks.
        if (!ours && holds && at !== undefined && heads?.get(repo, branch) === undefined) {
          if (await alreadyWritten(at, asked)) {
            heads?.set(repo, branch, at);
            ours = true;
            log.info(
              { repo, number: existing.number, branch, commit: at },
              'the pin branch is already the commit the watch would write: the watch takes it as its own',
            );
          }
        }
        if (!ours) {
          log.warn(
            { repo, number: existing.number, branch },
            'the pin branch is not at the commit the watch wrote: the watch writes its own again',
          );
        } else if (holds) {
          if (existing.title !== title || (existing.body ?? '') !== body)
            await actions.updatePullRequest(repo, existing.number, { title, body });
          const { body: pull } = await github.poll(repo, `/repos/${repo}/pulls/${existing.number}`, PULL);
          if (pull.mergeable !== false) continue;
        }
      } else if (await closedByMartin(branch, hash)) {
        say(
          `closed ${branch} ${hash}`,
          { branch },
          'Martin closed this pull request: the watch waits for the day’s moves there to change',
        );
        continue;
      } else {
        // A branch someone else's pull request stands on is not the watch's to move: nothing is committed, and GitHub
        // would refuse a second pull request from it.
        const other = theirs.find((p) => p.head.ref === branch);
        if (other) {
          const error = new BranchRefused(
            `Pull request #${other.number}, which the App did not open, is open from ${branch}: the pin watch writes no branch another's pull request stands on.`,
          );
          await refused(run, branch, error, other.number);
          wantAll(carried, BRANCH_HELD);
          continue;
        }
      }
      let commit: string;
      try {
        commit = await actions.commitPins(repo, asked);
      } catch (error) {
        if (error instanceof BranchRefused || (error instanceof PatchRefused && error.kind === 'protected')) {
          await refused(run, branch, error, existing?.number ?? null);
          continue;
        }
        if (error instanceof GitHubError && error.kind === 'conflict') {
          // main moved since the pass read it: the next pass reads it again.
          again = true;
          log.info({ repo, branch, err: error }, 'main moved while the pin watch wrote a move: tries again');
          continue;
        }
        throw error;
      }
      recorded.set(branch, fingerprint);
      heads?.set(repo, branch, commit);
      if (existing) {
        await actions.updatePullRequest(repo, existing.number, { title, body });
        log.info(
          { repo, number: existing.number, commit },
          holds ? 'made the pin moves again on main' : 'moved the pin pull request to the day’s moves',
        );
      } else {
        // An open that fails costs this branch alone, and the pass goes on: thrown, it would end the pass before it
        // was marked as made, and the next poll would commit to the branch again.
        try {
          const made = await actions.openPullRequest(repo, {
            head: branch,
            base: 'main',
            title,
            body,
            labels: [PIN_LABEL],
          });
          log.info({ repo, number: made.number, commit, moves: carried.length }, 'opened a pin pull request');
        } catch (error) {
          if (error instanceof BranchRefused || (error instanceof PatchRefused && error.kind === 'protected')) {
            await refused(run, branch, error, null);
          } else if (error instanceof GitHubError && !PASSING.includes(error.kind)) {
            await refused(
              run,
              branch,
              new BranchRefused(`GitHub refused a pull request from ${branch} into main: ${error.message}`),
              null,
            );
          } else if (error instanceof GitHubError) {
            // A limit or an outage: nothing is refused, and the next pass opens it.
            log.warn({ repo, branch, commit, err: error }, 'the pin pull request was not opened yet: tries next pass');
            continue;
          } else {
            throw error;
          }
          wantAll(carried, OPEN_REFUSED);
        }
      }
    }

    // A pull request with no move left: closed, with a sentence. Told only some moves, the watch closes one only when
    // every move it carries is among them, by the mark the watch wrote in its description.
    const own = (pull: Pull) => {
      const carries = carriedBy(pull.body);
      return carries.length > 0 && carries.every((name) => named.has(name));
    };
    for (const pull of open) {
      if (keep.has(pull.head.ref) || !(every || own(pull))) continue;
      const sentence = `${RunText(day)} no longer lists a move here that a pull request of the factory's makes: \`main\` has moved its pins, or the scan has nothing left to move them for. Closed; the watch opens another if the scan lists one.`;
      await actions.closePullRequest(repo, pull.number, sentence);
      heads?.delete(repo, pull.head.ref);
      log.info({ repo, number: pull.number }, 'closed a pin pull request with no move left');
    }

    // One issue for each move the App cannot write: opened once, updated, and closed when it is gone.
    for (const [key, issue] of wanted) {
      const found = issues.get(key);
      if (!found) {
        if (actions.dryRun && recorded.get(`issue ${key}`) === `${issue.title}\n${issue.body}`) continue;
        recorded.set(`issue ${key}`, `${issue.title}\n${issue.body}`);
        const number = await actions.openIssue(repo, { title: issue.title, body: issue.body, labels: [PIN_LABEL] });
        log.info({ repo, number, key }, 'opened a pin issue');
        continue;
      }
      if (found.state !== 'open') {
        // Closed by Martin: opened again only for a later target than it was written for. Closed by the watch, or by
        // anyone else: again.
        const same = TARGET_MARK.exec(found.body ?? '')?.[1] === targetMark(issue.target);
        if (same && (await closedBy(found.number)) === 'martin') continue;
        await actions.reopenIssue(
          repo,
          found.number,
          same ? `${RunText(day)} lists this move again.` : `${RunText(day)} lists this move again, to a later target.`,
        );
      }
      if ((found.body ?? '') !== issue.body || found.title !== issue.title)
        await actions.updateIssue(repo, found.number, { title: issue.title, body: issue.body });
    }
    for (const [key, issue] of issues) {
      if (issue.state !== 'open' || wanted.has(key) || !(every || ownIssues.has(key))) continue;
      await actions.closeIssue(
        repo,
        issue.number,
        'completed',
        `${RunText(day)} no longer lists this move as one the App cannot make: it is moved, made by a pull request of the factory's, or the scan has nothing left to move it for.`,
      );
      log.info({ repo, number: issue.number, key }, 'closed a pin issue whose move is gone');
    }
    last = again ? undefined : now();
  };
}
