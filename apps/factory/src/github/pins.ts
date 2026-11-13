/**
 * The pin watch (task 33): for each move of this repository's that a pull request can make, one pull request of the
 * App's, on `factory/pin/<move>`, that replaces the version or digest at each of the move's pins and changes nothing
 * else; for each move the App cannot write, one issue. Beside the deploy watch (`deploys.ts`), and like it the App's.
 *
 * Each pass, at most hourly, it reads the scan's day (`reads.moves`: the last finished run of `vulnerabilities.yml` on
 * `main`, its `moves.json` checked against the alerts) and Dependabot's open pull requests, and then:
 *
 * - **A move in the `worker`, `approval` or `cluster` lane** is committed on `main`'s head, signed by GitHub as every
 *   commit of the App's is, through `commitPins`, whose guard (`pin-guard.ts`) lets the commit replace the version or
 *   digest at each pin and nothing else, and refuses, with a signed record, anything it cannot prove is that; then one
 *   pull request is opened from the branch, labelled `pin`. Its description is the factory's own: each pin before and
 *   after, what the move clears in counts, its deadline, and when it waits for Martin, why and what to do. A move whose
 *   target moves on moves its branch, in one forced update, and its pull request's title and description with it; one
 *   whose pull request conflicts with `main` is committed again on `main`'s head. A pull request Martin closed without
 *   merging it is not opened again for the same target. Two moves that name one line, or one branch, are both refused.
 * - **It does not fight Dependabot.** A move Dependabot's pull request already moves, by its branch's pin or by the
 *   lines a group's changes rewrite, to the same target or a newer one, is Dependabot's: the watch opens nothing for
 *   it, and closes its own with a sentence naming Dependabot's. It never pushes to Dependabot's branch or closes its
 *   pull request: the actions refuse both, as a branch the factory does not own and a pull request the App did not open.
 *   A pin Dependabot reads with no High or Critical on a deadline is in the `dependabot` lane, and never the watch's.
 * - **A move in the `issue` lane**, a line no longer built, and a move the watch cannot write on its pins' lines, is
 *   one issue, labelled `pin`, that `/implement` can take as it stands: its pins, its target, its counts and its
 *   deadline. It is found again by the mark in its body, and updated, never opened twice; one Martin closed is opened
 *   again only for a later target.
 * - **A move that is gone** closes its pull request, or its issue, with a sentence.
 *
 * What it writes names the move and its counts, never a package or advisory of an open finding: a lockfile's move,
 * which the scan names by its file alone, is only ever an issue, named by its file and its first alert's number.
 *
 * Nothing acts on a day it could not read whole: a moves read that fails, or a run that uploaded no `moves.json`, opens
 * and closes nothing. A `moves.json` that lists no move, its count held to the alerts as every day's is, is a day with
 * nothing to move, and closes what the watch has open. A pin whose line has changed since the scan read it waits for
 * the next scan, and its pull request stays.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import { compareVersions } from '../vulnerabilities/deadlines.ts';
import { readTarget, type Target } from '../vulnerabilities/fixes.ts';
import { SEVERITIES } from '../vulnerabilities/sarif.ts';
import { type Actions, APP_LOGIN } from './actions.ts';
import { BranchRefused, PIN_PREFIX, type WatchedHeads } from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import { type DependencyPull, groupMovesTo } from './dependabot.ts';
import { PatchRefused } from './patches.ts';
import { type PinEdit, type PinSource, pinBranchFor, spans, treeSource } from './pin-guard.ts';
import type { Watch } from './poller.ts';
import type { Reads } from './reads.ts';
import type { RefusalRecorder } from './refusals.ts';
import type { Moves, ReadMove } from './scanning.ts';

/** The repositories whose pins the watch moves: this one. The app's moves are its line's. */
export const PIN_REPOS: readonly string[] = ['the-roganator/cv-software-factory'];

/** The label on every pull request and issue the watch opens. */
export const PIN_LABEL = 'pin';

/** The lanes whose moves are a pull request of the watch's, and those that are an issue. */
const PULL_LANES = new Set(['worker', 'approval', 'cluster']);
const ISSUE_LANES = new Set(['issue', 'none']);

/** How often a pass reads the day: the scan runs daily, and a pass is idempotent. */
export const PASS_MS = 60 * 60_000;

export interface PinWatchDependencies {
  github: GitHub;
  reads: Pick<Reads, 'moves' | 'dependencyPulls'>;
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
   * branch at any other commit, moved by anyone, or not yet written by this worker, is written again.
   */
  heads?: WatchedHeads;
  log: Logger;
  now?: () => number;
  /**
   * The moves it takes (`PIN_WATCH_ONLY`): `'*'` for every move of the day, or their names. A move outside it is never
   * opened, updated or closed, nor its issue; told nothing (no names, the default), the watch takes no move at all.
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

const CLOSED_BY = z.object({ closed_by: z.object({ login: z.string() }).nullable().optional() });
const PULLS = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    body: z.string().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    user: z.object({ login: z.string() }).nullable(),
    labels: z.array(z.object({ name: z.string() })),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  }),
);
const PULL = z.object({ mergeable: z.boolean().nullable() });
const BRANCH = z.object({ object: z.object({ sha: z.string() }) });
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

/** The mark that finds a move's issue again, and the target it was written for. */
const ISSUE_MARK = /<!-- factory: pin-issue ([a-z0-9][a-z0-9.-]*) -->/;
/** The target, URI-encoded, so nothing in it can end the comment it is in. */
const TARGET_MARK = /<!-- factory: pin-target ([A-Za-z0-9%._~!*'()-]*) -->/;
const targetMark = (target: string) => encodeURIComponent(target);
/** The mark that says which edits a pull request's branch was committed with, so a change of pins commits again. */
const EDITS_MARK = /<!-- factory: pin-edits ([0-9a-f]{64}) -->/;
const editsHash = (edits: readonly PinEdit[]) => createHash('sha256').update(JSON.stringify(edits)).digest('hex');

/** A move's name as code in a description: no backtick, no line break. */
const code = (text: string) => `\`${text.replace(/[`\r\n]/g, '')}\``;

const counted = (counts: ReadMove['clears']) =>
  SEVERITIES.filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s.toLowerCase()}`)
    .join(', ') || 'nothing';

/** A version as the target writes it, to compare with what Dependabot moves a pin to. */
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

/** A name as Docker would compare it: no registry for Docker Hub, no `library/`. */
const bare = (name: string) =>
  name
    .replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '')
    .replace(/^library\//, '')
    .split('@')[0]
    ?.replace(/:[^/]*$/, '') ?? name;

const directoryOf = (file: string) => `/${file.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') || '/';

/**
 * Dependabot's open pull request that moves a move's pin to its target or a newer one, if one does: one whose branch
 * names the pin's dependency in its directory, or a group's that rewrites the pin's line; or a group's whose patch of
 * the pin's file GitHub did not send, which may.
 */
export function dependabotHas(
  move: Pick<ReadMove, 'name' | 'pins'>,
  target: Target,
  pulls: readonly DependencyPull[],
): { number: number; version: string } | undefined {
  const want = versionOf(target);
  if (!want) return undefined;
  const atLeast = (version: string) => compareVersions(version, want) >= 0;
  for (const pull of pulls) {
    if (pull.dependency !== null && pull.version !== null && pull.directory !== null) {
      const dirs = new Set(move.pins.map((pin) => directoryOf(pin.file)));
      const named = bare(pull.dependency) === bare(move.name) && dirs.has(pull.directory.replace(/\/+$/, '') || '/');
      if (named && atLeast(pull.version)) return { number: pull.number, version: pull.version };
      continue;
    }
    if (move.pins.some((pin) => pull.unread.includes(pin.file)))
      return { number: pull.number, version: 'a version its patch does not show' };
    // A group's has the move when it changes the pin's line to the move's target: its tag or further, or its digest.
    for (const pin of move.pins) {
      const moves = groupMovesTo(pull, pin);
      if (moves?.version && atLeast(moves.version)) return { number: pull.number, version: moves.version };
      if (target.kind === 'image' && moves?.digests.includes(target.digest))
        return { number: pull.number, version: `${target.tag}@${target.digest}` };
    }
  }
  return undefined;
}

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
  const tag = from.split('@')[0] ?? from;
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
    const digest = /^@sha256:[0-9a-f]{64}/.exec(line.slice(start + each.from.length))?.[0];
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

/** Why a move waits for Martin, and what to do, by its lane and what it moves; undefined when the gate may pass it. */
function waitsFor(move: ReadMove): string | undefined {
  if (move.lane === 'cluster')
    return 'k3s moves with your cluster, so the review gate holds it for you. Approve and merge it, then run `make upgrade-cluster`, which moves the local cluster to the new pin and keeps everything in it.';
  if (move.lane === 'approval')
    return 'It crosses a major, which the review gate holds for you. Read what the new major changes, and approve it if nothing else needs to change with it; otherwise close it, and the move becomes an issue.';
  if (/(^|\/)(trivy|syft)$/.test(bare(move.name)))
    return 'It moves a scanner’s own pin, which the review gate holds for you: a scanner cannot vouch for its replacement. Approve it once the scans on it read as you expect.';
  return undefined;
}

/** A pull request's description, the factory's own. */
export function pullBody(move: ReadMove, edits: readonly PinEdit[], moves: Moves): string {
  const lines = [
    `The factory's pin watch moves ${code(move.name)} from ${code(move.from)} to ${code(move.to)}, as ${runText(moves)} found (judged ${moves.file?.judged ?? 'then'}). It changes nothing but the version or digest at each pin.`,
    '',
    '| Pin | Before | After |',
    '| --- | --- | --- |',
    ...edits.map((edit) => `| ${code(`${edit.file}:${edit.line}`)} | ${code(edit.from)} | ${code(edit.to)} |`),
    '',
    `It clears ${counted(move.clears)}, and leaves ${counted(move.leaves)} on the same pins.`,
    '',
    `Deadline: ${move.deadline ?? 'none'}.`,
    '',
  ];
  const waits = waitsFor(move);
  lines.push(
    waits
      ? `**It waits for you.** ${waits}`
      : 'The review gate passes it as `pin-move` when it proves the move from this pull request alone, and the worker then adds it to the merge queue once its checks are green. If it cannot, its `review` check says why it waits for you: your approval of its head passes it, and adding it to the queue is yours.',
    '',
    `<!-- factory: pin-edits ${editsHash(edits)} -->`,
  );
  return `${lines.join('\n')}\n`;
}

/** Why the App cannot write a move, and what to do instead, for its issue. */
function cannotWrite(move: ReadMove, why?: string): string {
  if (why)
    return `The watch cannot write it on its pins' lines (${why}): move it by hand, and the scan's next run sees it.`;
  if (move.lane === 'none')
    return 'Its line is no longer built: nothing on this line will bring the fix. Move the pin to a line its publisher builds, and the scan reads it from there.';
  if (move.lockfile)
    return 'A lockfile moves by its package manager, and the App writes none: update the package with pnpm, and its code scanning alerts say which.';
  if (move.pins.some((pin) => /(^|\/)mise\.(toml|lock)$/.test(pin.file) || pin.file === 'Makefile'))
    return 'mise or the Makefile pins it, and the toolchain moves only when someone upgrades it: `mise upgrade`, with both of mise’s files, in a `chore(toolchain)` pull request.';
  if (move.pins.some((pin) => pin.file.startsWith('.github/')))
    return 'A workflow pins it, and the App writes no workflow: move it in a pull request of your own.';
  return 'It needs more than its pins’ lines written, which no pull request of the App’s makes: move it in a pull request of your own.';
}

/** The key an issue is found again by: the move's name, or for a lockfile's, its first alert, which names no package. */
function issueKey(move: ReadMove): string {
  if (move.lockfile) {
    const first = Math.min(...move.findings.map((f) => f.alert));
    return `lockfile-alert-${Number.isFinite(first) ? first : move.index}`;
  }
  return pinBranchFor(move.name).slice(PIN_PREFIX.length);
}

/** An issue's title and description. */
export function issueOf(move: ReadMove, moves: Moves, why?: string): { title: string; body: string; key: string } {
  const key = issueKey(move);
  const first = key.startsWith('lockfile-alert-') ? key.slice('lockfile-alert-'.length) : undefined;
  const name = move.lockfile ? `${move.name} (code scanning alert #${first})` : move.name;
  const to = move.lockfile ? 'the version its alerts name' : move.to || 'a line that is built';
  const title =
    move.lane === 'none'
      ? `Move ${name.replace(/`/g, '')} off a line no longer built`
      : `Move ${name.replace(/`/g, '')} to ${to}`;
  const pins = move.lockfile
    ? [...new Set(move.pins.map((pin) => pin.file))].map((file) => `- ${code(file)}`)
    : move.pins.map((pin) => `- ${code(`${pin.file}:${pin.line}`)}, pinning ${code(move.from)}`);
  const body = [
    `<!-- factory: pin-issue ${key} -->`,
    `<!-- factory: pin-target ${targetMark(move.to)} -->`,
    `${RunText(moves)} lists a move the factory's pin watch cannot make with a pull request of its own: ${code(move.name)}${move.lockfile ? '' : ` from ${code(move.from)}`} to ${move.lockfile ? to : code(to)}.`,
    '',
    cannotWrite(move, why),
    '',
    '**Pins**',
    '',
    ...pins,
    '',
    `**Clears** ${counted(move.clears)}; leaves ${counted(move.leaves)} on the same pins.`,
    '',
    `**Deadline** ${move.deadline ?? 'none'}.`,
    '',
    'The watch keeps this issue to the scan: it updates it as the move changes, and closes it once the scan no longer lists the move.',
    '',
  ].join('\n');
  return { title: title.slice(0, 256), body, key };
}

/** A pull request's title: what it moves, and to what. */
export function pullTitle(move: ReadMove, target: Target): string {
  return pinTitle(move.name, versionOf(target) ?? move.to);
}

/** Whether a move's title holds its name and version as they are: nothing taken out, nothing cut. */
export const titleIsExact = (name: string, to: string): boolean => {
  const whole = `chore(pin): move ${name} to ${to}`;
  // Under GitHub's 256, so a title is never one cut to that length: the queue reads one that long as cut.
  return whole.length < 256 && pinTitle(name, to) === whole;
};

/** The title of a move's pull request, from its name and the version it moves to: what the pin queue reads it by. */
export const pinTitle = (name: string, to: string): string =>
  `chore(pin): move ${name.replace(/[`\r\n]/g, '')} to ${to}`.slice(0, 256);

/** Watches this repository's moves, and keeps one pull request, or one issue, for each. */
export function pinWatch(deps: PinWatchDependencies, repo: string): Watch {
  const { github, reads, actions, recorder, log, now = Date.now, source = treeSource(github), only = [], heads } = deps;
  if (!PIN_REPOS.includes(repo)) throw new Error(`The pin watch does not move ${repo}'s pins: its line does.`);
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

  /** Whether the App closed an issue or pull request itself, rather than Martin: only his close holds a target back. */
  const closedByApp = async (number: number): Promise<boolean> => {
    const { body } = await github.poll(repo, `/repos/${repo}/issues/${number}`, CLOSED_BY);
    return body.closed_by?.login === APP_LOGIN;
  };

  const openPulls = async (): Promise<Pull[]> => {
    const out: Pull[] = [];
    for (let page = 1; page <= PAGES; page++) {
      const { body } = await github.poll(repo, `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, PULLS);
      out.push(
        ...body.filter(
          (p) => p.user?.login === APP_LOGIN && p.head.repo?.full_name === repo && p.head.ref.startsWith(PIN_PREFIX),
        ),
      );
      if (body.length < 100) return out;
    }
    throw new GitHubError('malformed', `${repo} has more open pull requests than the pin watch reads.`);
  };

  /** Whether Martin closed, without merging it, a pull request of the App's on this branch for the same target. */
  const closedByMartin = async (branch: string, title: string): Promise<boolean> => {
    const [owner] = repo.split('/');
    const { body } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=closed&per_page=20&head=${owner}:${encodeURIComponent(branch)}`,
      PULLS,
    );
    for (const pull of body)
      if (
        pull.user?.login === APP_LOGIN &&
        pull.head.repo?.full_name === repo &&
        !pull.merged_at &&
        pull.title === title
      )
        if (!(await closedByApp(pull.number))) return true;
    return false;
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

  // The branches and issue keys of the moves it was told to take: nothing else of the App's is closed as gone.
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
    // What a gone move of the watch's may be closed by: a named move's branch and issue, unless a move it was not told
    // to take has that branch too (a name folds to its branch, so another name can share it), and every taken move's.
    const others = new Set(read.moves.filter((move) => !taken.includes(move)).map((move) => pinBranchFor(move.name)));
    const ownBranches = new Set([...named].map(pinBranchFor).filter((branch) => !others.has(branch)));
    const ownIssues = new Set([
      ...[...ownBranches].map((branch) => branch.slice(PIN_PREFIX.length)),
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
    const [pulls, open, issues] = await Promise.all([reads.dependencyPulls(repo), openPulls(), pinIssues()]);
    const head = await source.head(repo);
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

    // Two moves that name one line, or make one branch, are both refused: neither is the one move of that pin.
    // Read over every move of the day, taken or not: a move named alone is still refused beside a rival it was not told.
    const writable = (m: ReadMove) => PULL_LANES.has(m.lane) && !m.lockfile;
    const writing = day.moves.filter(writable);
    const byPlace = new Map<string, ReadMove[]>();
    const byBranch = new Map<string, ReadMove[]>();
    for (const move of read.moves.filter(writable)) {
      for (const pin of move.pins) {
        const key = `${pin.file}:${pin.line}`;
        byPlace.set(key, [...(byPlace.get(key) ?? []), move]);
      }
      const branch = pinBranchFor(move.name);
      byBranch.set(branch, [...(byBranch.get(branch) ?? []), move]);
    }

    /** The branches today's moves keep (their pull requests stay), and why one of those is closed instead. */
    const keep = new Set<string>();
    const closeWith = new Map<string, string>();
    /** The issues today's moves keep, each with what it says. */
    const wanted = new Map<string, { title: string; body: string; target: string }>();
    const want = (move: ReadMove, why?: string) => {
      const issue = issueOf(move, day, why);
      wanted.set(issue.key, { title: issue.title, body: issue.body, target: move.to });
    };

    for (const move of day.moves) {
      // A lockfile's move is only ever an issue, a major's among them; in the `dependabot` lane, its first day, it is
      // Dependabot's alone, as any move there is.
      if (ISSUE_LANES.has(move.lane) || (move.lockfile && PULL_LANES.has(move.lane))) want(move);
      if (move.lane === 'dependabot' && !move.lockfile)
        closeWith.set(
          pinBranchFor(move.name),
          `${RunText(day)} gives this pin to Dependabot now: nothing on a deadline at High or Critical needs it moved sooner. Closed, so the two do not both move it.`,
        );
    }

    for (const move of writing) {
      const branch = pinBranchFor(move.name);
      const existing = open.find((p) => p.head.ref === branch);
      const target = readTarget(move.to);
      if (
        !target ||
        (target.kind !== 'image' && target.kind !== 'chart' && target.kind !== 'k3s' && target.kind !== 'version')
      ) {
        want(move, `its target, ${move.to || 'none'}, is not a version or digest a pin's line writes`);
        continue;
      }
      // A pull request's title names its move exactly, for the pin queue reads the move by it: a name the title would
      // alter (a backtick, a line break) or cut (past 256 characters) gets an issue instead.
      if (!titleIsExact(move.name, versionOf(target) ?? move.to)) {
        want(move, 'its name cannot be a pull request’s title whole: a backtick or line break in it, or too long');
        continue;
      }
      const twice = [...new Set(move.pins.flatMap((pin) => byPlace.get(`${pin.file}:${pin.line}`) ?? []))];
      if (twice.length > 1 || (byBranch.get(branch)?.length ?? 0) > 1) {
        keep.add(branch);
        const others = twice.length > 1 ? twice : (byBranch.get(branch) ?? []);
        const error =
          twice.length > 1
            ? new PatchRefused(
                'protected',
                `Moves ${others.map((m) => m.name).join(' and ')} name one line: neither is the one move of that pin.`,
              )
            : new BranchRefused(
                `Moves ${others.map((m) => m.name).join(' and ')} make one branch, ${branch}: neither is opened.`,
              );
        await refused(run, branch, error, existing?.number ?? null);
        continue;
      }
      const theirs = dependabotHas(move, target, pulls);
      if (theirs) {
        closeWith.set(
          branch,
          `Dependabot's #${theirs.number} moves this pin to ${theirs.version}, as far as this move needs or further. Closed, so the two do not both move it; Dependabot's is left as it is.`,
        );
        say(
          `dependabot ${run} ${branch} ${theirs.number}`,
          { branch, pull: theirs.number },
          'Dependabot moves this pin: the watch opens nothing',
        );
        continue;
      }

      // The edits, from each pin's line at main's head, which must still be the line the scan read.
      const edits: PinEdit[] = [];
      let why: string | undefined;
      let waits = false;
      for (const file of [...new Set(move.pins.map((pin) => pin.file))]) {
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
          `waits ${run} ${branch} ${head}`,
          { branch, head },
          'a pin’s line has changed since the scan: the move waits for the next',
        );
        continue;
      }
      if (why) {
        want(move, why);
        continue;
      }

      keep.add(branch);
      const title = pullTitle(move, target);
      const body = pullBody(move, edits, day);
      const fingerprint = `${title}\n${editsHash(edits)}`;
      if (!existing && actions.dryRun && recorded.get(branch) === fingerprint) continue;
      if (existing?.title === title) {
        if (!existing.labels.some((l) => l.name === PIN_LABEL))
          await actions.addLabels(repo, existing.number, [PIN_LABEL]);
        // Its branch at any commit but the one the watch wrote (moved by anyone, or not yet written by this worker): the
        // watch writes its own again, and its queue adds nothing meanwhile.
        // Read from the branch itself, as GitHub's list of pull requests may name a head a push since has moved.
        const ours = heads === undefined || (await branchAt(branch)) === heads.get(repo, branch);
        if (!ours) {
          log.warn(
            { repo, number: existing.number, branch },
            'the pin branch is not at the commit the watch wrote: the watch writes its own again',
          );
        }
        // Its branch was committed with these edits: only its description, and a conflict with main, are left.
        else if (EDITS_MARK.exec(existing.body ?? '')?.[1] === editsHash(edits)) {
          if ((existing.body ?? '') !== body) await actions.updatePullRequest(repo, existing.number, { body });
          const { body: pull } = await github.poll(repo, `/repos/${repo}/pulls/${existing.number}`, PULL);
          if (pull.mergeable !== false) continue;
        }
      } else if (!existing && (await closedByMartin(branch, title))) {
        say(
          `closed ${branch} ${title}`,
          { branch },
          'Martin closed this move’s pull request: the watch waits for a later target',
        );
        continue;
      }
      let commit: string;
      try {
        commit = await actions.commitPins(repo, { branch, base: head, scanned, message: title, pins: edits });
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
      if (existing?.title === title) {
        await actions.updatePullRequest(repo, existing.number, { body });
        log.info({ repo, number: existing.number, commit }, 'made the pin move again on main');
      } else if (existing) {
        await actions.updatePullRequest(repo, existing.number, { title, body });
        log.info({ repo, number: existing.number, commit }, 'moved the pin pull request to a later target');
      } else {
        const made = await actions.openPullRequest(repo, {
          head: branch,
          base: 'main',
          title,
          body,
          labels: [PIN_LABEL],
        });
        log.info({ repo, number: made.number, commit }, 'opened a pin pull request');
      }
    }

    // A move gone: its pull request is closed, with a sentence.
    for (const pull of open) {
      if (keep.has(pull.head.ref) || !(every || ownBranches.has(pull.head.ref))) continue;
      const sentence =
        closeWith.get(pull.head.ref) ??
        `${RunText(day)} no longer lists this move as one a pull request of the factory's makes: \`main\` has moved its pin, the move needs more than its pins written, or nothing it cleared is left. Closed; the watch opens another if the scan lists one.`;
      await actions.closePullRequest(repo, pull.number, sentence);
      heads?.delete(repo, pull.head.ref);
      log.info({ repo, number: pull.number }, 'closed a pin pull request whose move is gone');
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
        // Closed by Martin: opened again only for a later target than it was written for. Closed by the watch: again.
        const same = TARGET_MARK.exec(found.body ?? '')?.[1] === targetMark(issue.target);
        if (same && !(await closedByApp(found.number))) continue;
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
        `${RunText(day)} no longer lists this move as one the App cannot make: it is moved, made by a pull request of the factory's, or nothing it cleared is left.`,
      );
      log.info({ repo, number: issue.number, key }, 'closed a pin issue whose move is gone');
    }
    last = again ? undefined : now();
  };
}
