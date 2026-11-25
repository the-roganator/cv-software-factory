/**
 * What the harness decides from what it has read, apart from the reading, so each decision is tested
 * (decide.test.ts): whether a scan's move is a routine one, whether a pull request must be read again, when a test's
 * failure is certain before its limit, how long "nothing after" is, what the app's pins of the factory's workflows
 * say, whether a hold still stands, and what an issue, a ticket or Dependabot's pull request must show. Nothing here
 * reads GitHub, the cluster or a file.
 */
import { createHash } from 'node:crypto';

// ── A scan's moves ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ListedMove {
  name: string;
  lane: string;
  /** The version its pins hold; '' for a lockfile's move, which withholds it. */
  from: string;
  to: string;
  clears?: Record<string, number>;
}
/** How many findings a move clears, of every severity. */
export const cleared = (move: Pick<ListedMove, 'clears'>) =>
  Object.values(move.clears ?? {}).reduce((sum, n) => sum + n, 0);
/**
 * A routine move as `moves.json` shows one: a pin that is merely behind, so it clears nothing, in a lane that moves it.
 * A lockfile's public move withholds its target, so `to` cannot say; the lane `none` is a finding nothing moves.
 */
export const isRoutine = (move: Pick<ListedMove, 'clears' | 'lane'>) => cleared(move) === 0 && move.lane !== 'none';

/**
 * Whether a pin branch is one of routine updates, which ride apart from the moves a finding asks for (pin-guard.ts's
 * `pinBranchFor`): `factory/pin/<path>-routine-<8 hex>`, or `-routine-major-<8 hex>` across a major.
 */
export const routineBranch = (branch: string | undefined) =>
  /^factory\/pin\/.*-routine(-major)?-[0-9a-f]{8}$/.test(branch ?? '');
/** Whether a pin branch is one of routine updates across a major, which the level may hold apart from the rest. */
export const routineMajorBranch = (branch: string | undefined) =>
  /^factory\/pin\/.*-routine-major-[0-9a-f]{8}$/.test(branch ?? '');
/**
 * Whether a pin branch is the kind a test stands on: a finding's moves (any branch that is not of routine updates), or
 * routine updates, and then across a major or not as the test is.
 */
export const branchFits = (branch: string | undefined, test: { routine?: boolean; major?: boolean }) =>
  test.routine ? routineBranch(branch) && routineMajorBranch(branch) === Boolean(test.major) : !routineBranch(branch);
/**
 * Whether a scan's move is the kind a test stands on. A routine update and a finding's move may share a name (a
 * lockfile's names no package), and so may a routine update across a major and one within it.
 */
export const moveFits = (
  move: Pick<ListedMove, 'clears' | 'lane'> & { major?: boolean },
  test: { routine?: boolean; major?: boolean },
) => (test.routine ? isRoutine(move) && Boolean(move.major) === Boolean(test.major) : !isRoutine(move));

/**
 * The moves of the next scan that a merged move should have ended: those with the name and the pinned version of a
 * move the first scan listed. A move of the same name from another version is a new one (a chart moved to 29.49.0,
 * then listed from 29.49.0 to its next release), and is not the first still there. A lockfile's moves withhold their
 * versions, so every one of a name is kept, and they are told apart by what they clear, or counted.
 */
export const stillListed = <M extends Pick<ListedMove, 'name' | 'from'>>(
  before: readonly Pick<ListedMove, 'name' | 'from'>[],
  after: readonly M[],
): M[] => after.filter((a) => before.some((b) => b.name === a.name && b.from === a.from));

/** The version a move's target names, as a pin pull request's title writes it: a chart's, an image's tag, k3s's. */
export function targetOf(to: string): string | undefined {
  return (/^chart \S+ (\S+)/.exec(to) ?? /^image ([^@\s]+)/.exec(to) ?? /^k3s (\S+)/.exec(to))?.[1];
}
/**
 * Whether a pin pull request's title names another target than the scan's move does: it was opened from an earlier
 * scan, so what it deploys is never what this run's scan asks for. Undefined when the title is not one move's, or the
 * move's target is not a version.
 */
export function staleTarget(title: string, move: Pick<ListedMove, 'name' | 'to'>): string | undefined {
  const named = /^chore\(pin\): move (.+) to (\S+)$/.exec(title);
  const want = targetOf(move.to);
  if (!named || named[1] !== move.name || !want) return undefined;
  return named[2] === want ? undefined : `it moves ${move.name} to ${named[2]}, and the scan's move is to ${want}`;
}

// ── Whether a pull request must be read again ───────────────────────────────────────────────────────────────────────

/**
 * One cheap look at many pull requests: a GraphQL query (its budget is apart from the REST one) that returns, for each
 * number, what a change in any field of the harness's reading of it would also change. The checks are the head's, as
 * the pull request page rolls them up; with more than a hundred the look cannot stand for them (`printOf`).
 */
export function probeQuery(numbers: number[]): string {
  const each = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ...Probe }`).join(' ');
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${each} } }
fragment Probe on PullRequest { number state updatedAt mergedAt headRefOid isInMergeQueue timelineItems { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes { __typename
    ... on CheckRun { databaseId name status conclusion title summary }
    ... on StatusContext { context state } } } } } } } }`;
}
/**
 * A pull request's print from that look: the same print, the same reading. It holds the pull request's state, head,
 * place in the merge queue, `updatedAt` and timeline length (a title, a label, a comment, a person's act), and of its
 * head's checks those the reading judges: each required one and the gate's `review`, by its run, whether it has
 * finished and how, and the gate's words. A check that is not required changes no field but `touched` (a person ran it
 * again), which a run's last reading, made in full, always has. Undefined when the look cannot stand for the reading:
 * no such pull request, or more checks than it lists.
 */
// biome-ignore lint/suspicious/noExplicitAny: GitHub's JSON, as given
export function printOf(node: any, required: string[]): string | undefined {
  if (!node) return undefined;
  const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  if (contexts && contexts.totalCount > (contexts.nodes?.length ?? 0)) return undefined;
  const judged = new Set([...required, 'review']);
  // biome-ignore lint/suspicious/noExplicitAny: GitHub's JSON, as given
  const checks = ((contexts?.nodes ?? []) as any[])
    .filter((c) => c.__typename === 'CheckRun' && judged.has(c.name))
    .map((c) => [
      c.databaseId,
      c.name,
      c.status === 'COMPLETED' ? c.conclusion : 'pending',
      c.name === 'review' ? `${c.title ?? ''} ${c.summary ?? ''}` : '',
    ])
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const said = [
    node.state,
    node.updatedAt,
    node.mergedAt ?? '',
    node.headRefOid,
    Boolean(node.isInMergeQueue),
    node.timelineItems?.totalCount ?? 0,
    checks,
  ];
  return createHash('sha256').update(JSON.stringify(said)).digest('hex');
}

// ── The scan's word on an image the registry did not serve ───────────────────────────────────────────────────────────

/** How the scan's run begins its line for an image it could not pull, before the image's name (deadlines.ts). */
export const NOT_PULLED = 'Image not read: ';
/** Whether a line of the scan's run says `image` was not read: the words, then a name that holds the image. */
export const saysNotPulled = (message: string, image: string) =>
  message.split('\n').some((line) => {
    const at = line.indexOf(NOT_PULLED);
    return at >= 0 && line.slice(at + NOT_PULLED.length).includes(image);
  });

// ── A failure that is certain before the limit ──────────────────────────────────────────────────────────────────────

export interface PullFacts {
  number: number;
  /** `open`, `closed` (unmerged) or `merged`. */
  state: string;
  title: string;
  head: string;
  red: string[];
  pending: string[];
  touched: string[];
}
/**
 * Why a test has failed for good, whatever the rest of its hour brings, or nothing while it may still pass. Each is a
 * state the verdict fails and nothing undoes: a pull request that must not merge has merged; of a move that must merge,
 * more than one pull request (the count only grows), its pull request closed unmerged, merged after a person touched
 * it, merged from an earlier scan's target, or red at a head the worker has said is out of runs or out of tries in the
 * queue (it writes that head no more). A watch ends such a test's wait at once; the verdict is read as ever, after it.
 */
export function certainFail(o: {
  mustHold: boolean;
  pulls: PullFacts[];
  /** The heads the App said are out of runs of their checks, or out of tries in the merge queue. */
  spent?: string[];
  /** The scan's moves the test stands on, for a pin's pull request. */
  moves?: Pick<ListedMove, 'name' | 'to'>[];
  /** For a move the worker makes: its word that it cannot read the scan's moves (`unreadMoves`), when it says so. */
  unread?: string | undefined;
}): string | undefined {
  const merged = o.pulls.find((p) => p.state === 'merged');
  if (o.mustHold) return merged ? `#${merged.number} merged, and must not` : undefined;
  if (o.pulls.length > 1) return `${o.pulls.length} pull requests, not one`;
  const [pull] = o.pulls;
  if (!pull) return o.unread ? `no pull request, and the worker cannot read the scan: ${o.unread}` : undefined;
  const tag = `#${pull.number}`;
  if (pull.state === 'closed') return `${tag} closed unmerged`;
  if (pull.state === 'merged') {
    if (pull.touched.length) return `${tag} merged, touched: ${pull.touched.join('; ')}`;
    for (const move of o.moves ?? []) {
      const stale = staleTarget(pull.title, move);
      if (stale) return `${tag} merged, and ${stale}`;
    }
    return undefined;
  }
  if (pull.red.length && !pull.pending.length && o.spent?.includes(pull.head))
    return `${tag} red (${pull.red.join(', ')}) at a head the App writes no more`;
  return undefined;
}

// ── The scan that confirms a run ────────────────────────────────────────────────────────────────────────────────────

export interface ScanRun {
  id: number;
  event: string;
  /** `completed`, or anything else while it is queued or running. */
  status: string;
  conclusion?: string | null;
  headSha: string;
  createdAt: string;
}
/**
 * Which scan of main confirms a run's merges, from the workflow's runs: the newest finished one on a commit that holds
 * every merge (`holds`), which may have left a `moves.json`; with none, the newest still queued or running on such a
 * commit, to wait for; with neither, one is dispatched. A run GitHub cancelled is never taken: the scan's job keeps one
 * pending run, so a push of main while one waits replaces it, and the one that replaced it is on a later commit and
 * confirms as well. Nor is one already found to have left no `moves.json` (`spent`), nor a pull request's proving run.
 */
export function pickScan(
  runs: readonly ScanRun[],
  holds: (headSha: string) => boolean,
  spent: ReadonlySet<number> = new Set(),
): { use: ScanRun } | { wait: ScanRun } | { dispatch: true } {
  const fit = runs
    .filter((run) => run.event !== 'pull_request' && !spent.has(run.id))
    .filter((run) => !(run.status === 'completed' && ['cancelled', 'skipped'].includes(run.conclusion ?? '')))
    .filter((run) => holds(run.headSha))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
  const finished = fit.find((run) => run.status === 'completed');
  if (finished) return { use: finished };
  const running = fit[0];
  return running ? { wait: running } : { dispatch: true };
}

// ── A batch's line in batch.env ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `PIN_WATCH_ONLY` as a line a shell reads back whole (`copies.sh` sources batch.env): the names in single quotes, as
 * they hold spaces, backticks and colons, with any single quote written `'\''`.
 */
export const pinWatchLine = (names: readonly string[]) => `PIN_WATCH_ONLY='${names.join(',').replace(/'/g, `'\\''`)}'`;
/**
 * batch.env's text with a setting's line put in place of any it has (`line` undefined takes the setting out), the
 * other lines kept: an empty file gains the line too.
 */
export function withSetting(text: string, key: string, line: string | undefined): string {
  const kept = text.split('\n').filter((l) => l !== '' && !l.startsWith(`${key}=`));
  return [...kept, ...(line === undefined ? [] : [line])].map((l) => `${l}\n`).join('');
}

// ── The worker's word that it cannot read the scan ──────────────────────────────────────────────────────────────────

/** How the GitHub worker begins its error when a scan's artifact does not read (apps/factory/src/github/scanning.ts). */
export const UNREAD_MOVES = /The scan's moves in \S+ cannot be read: [^"\\]*/;
/**
 * The worker's word, from its log, that it cannot read the scan's moves: the line quoted, once it has said so on three
 * passes and within the last three minutes, so one answer GitHub dropped is not taken for it. A scan it cannot read
 * stays unread until another scan, and no pull request of the worker's opens from it.
 */
export function unreadMoves(log: string, now: number): string | undefined {
  const said: { at: number; words: string }[] = [];
  for (const line of log.split('\n')) {
    const words = UNREAD_MOVES.exec(line)?.[0];
    if (!words) continue;
    let at = Number.NaN;
    try {
      at = Number(new Date(JSON.parse(line).time));
    } catch {}
    said.push({ at, words });
  }
  const last = said.at(-1);
  if (said.length < 3 || !last || !(now - last.at < 3 * 60_000)) return undefined;
  return last.words.trim().slice(0, 300);
}

// ── How long "nothing after" is ─────────────────────────────────────────────────────────────────────────────────────

/** The GitHub worker's poll when its Deployment sets none (apps/factory/src/github/config.ts). */
export const WORKER_POLL_S = 60;
/**
 * How long a head said to be out of runs is watched for anything after it (W1b): nine of the worker's passes, each of
 * which would write the head again if its rule let it, and three minutes at least for what a pass started to show on
 * GitHub.
 */
export const settleMs = (workerPollS: number | undefined) =>
  Math.max(3 * 60_000, 9 * (workerPollS && workerPollS > 0 ? workerPollS : WORKER_POLL_S) * 1000);

// ── The app's pins of the factory's workflows ───────────────────────────────────────────────────────────────────────

/** A caller's `uses:` of one of a repository's workflows at a commit, as Dependabot writes the line. */
export interface WorkflowPin {
  workflow: string;
  commit: string;
}
/** The pins of `repo`'s workflows in a workflow file's text: every `uses: <repo>/.github/workflows/<file>@<40 hex>`. */
export function workflowPins(text: string, repo: string): WorkflowPin[] {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`^\\s*(?:-\\s*)?uses:\\s*${escaped}/\\.github/workflows/([\\w.-]+)@([0-9a-f]{40})\\b`, 'gm');
  return [...text.matchAll(line)].map((m) => ({ workflow: m[1] as string, commit: m[2] as string }));
}
/**
 * Why the app's pins of the factory's workflows are not one commit, the one asked for: nothing when every pin is at
 * `commit`. `files` is each of the app's workflow files' text by path.
 */
export function pinsFault(
  files: Record<string, string>,
  repo: string,
  commit: string,
  count: number,
): string | undefined {
  const pins = Object.entries(files).flatMap(([path, text]) =>
    workflowPins(text, repo).map((pin) => ({ ...pin, path })),
  );
  if (pins.length !== count) return `${pins.length} pins of ${repo}'s workflows, not ${count}`;
  const off = pins.filter((pin) => pin.commit !== commit);
  return off.length
    ? `${off.map((pin) => `${pin.path} at ${pin.commit.slice(0, 7)}`).join(', ')}, not ${commit.slice(0, 7)}`
    : undefined;
}

// ── Whether the factory copy is at rest, for an app run ─────────────────────────────────────────────────────────────

/**
 * Why an app run may not start: what on the factory copy would roll the scratch cluster's factory while the app's test
 * is judged clean. An open pin pull request of the App's merges at Guarded, and its build makes a deploy pin; an open
 * deploy pin merges at every level. One deploy pin is no such thing: the one a reset leaves on a `main` that is still
 * the baseline, red by design, as its base reached `main` by a force-push and no merge queue ran it.
 */
export function factoryBusy(o: {
  /** The factory copy's open pull requests. */
  pulls: readonly { number: number; title: string; author: string }[];
  app: string;
  main: string;
  baseline: string;
}): string | undefined {
  const own = o.pulls.filter((p) => p.author === o.app);
  const pins = own.filter((p) => p.title.startsWith('chore(pin)'));
  const deploys = o.main === o.baseline ? [] : own.filter((p) => p.title.startsWith('chore(deploy)'));
  const open = [...pins, ...deploys];
  if (!open.length) return undefined;
  return `the factory copy has ${open.map((p) => `#${p.number}`).join(', ')} of the App's open (${[
    pins.length ? 'pin moves, which merge and are built' : '',
    deploys.length ? 'a deploy pin on a main past the baseline, which merges' : '',
  ]
    .filter(Boolean)
    .join('; ')}), and each would roll the factory under the app's test`;
}

// ── A hold, decided at one head and kept ────────────────────────────────────────────────────────────────────────────

export interface HoldFacts {
  number: number;
  /** `open`, `closed` (unmerged) or `merged`. */
  state: string;
  head: string;
  red: string[];
  pending: string[];
  /** The gate's rule at the head, once it has judged it; `held` with `gatePending` while it waits. */
  rule?: string | undefined;
  gatePending?: string | undefined;
  queuedBy?: string | undefined;
  touched: string[];
}
/**
 * Whether a pull request that must not merge is decided at its head: unmerged and never queued, with every required
 * check and the gate's verdict in. A forgery's is then final: no watch owns its branch. Any other's needs its checks
 * green too, and the worker's last word at that head (`said`) to be the one that ends its pass: `verdict` for a head
 * the gate held, `level` for one it passed, which the worker says only once the verdict, the checks and mergeability
 * are through.
 */
export function holdDecided(pull: HoldFacts, said: string | undefined, forged: boolean): boolean {
  if (pull.state === 'merged' || pull.queuedBy || pull.pending.length || pull.gatePending) return false;
  if (forged) return true;
  if (pull.red.length || pull.rule === undefined) return false;
  return pull.rule === 'held' ? said === 'verdict' : said === 'level';
}
/**
 * Why a hold decided at an earlier head no longer stands, or nothing while it does. The pin watch rightly writes a held
 * pull request's head again when `main` moves under it, and the checks and the worker's word at the new head may come
 * after the watch ends: pending checks there undo nothing. A merge does, a queue entry, anyone touching it, and a
 * verdict of the gate at the later head by another rule than the one it was held under (`rule`, for a major).
 */
export function holdBroken(pulls: readonly HoldFacts[], rule?: string): string | undefined {
  for (const p of pulls) {
    const tag = `#${p.number}`;
    if (p.state === 'merged') return `${tag} merged, and must not`;
    if (p.queuedBy) return `${tag} queued by ${p.queuedBy} after its hold was decided`;
    if (p.touched.length) return `${tag} touched: ${p.touched.join('; ')}`;
    if (rule && p.state === 'open' && p.rule !== undefined && !p.gatePending && p.rule !== rule)
      return `${tag}: the gate's rule at ${p.head.slice(0, 7)} is ${p.rule}, not ${rule}`;
  }
  return undefined;
}

// ── An issue that must say why ──────────────────────────────────────────────────────────────────────────────────────

export interface IssueFacts {
  number: number;
  author: string;
  title: string;
  body: string;
}
/** What an issue must show: words in code (a package, a version), words it says, and words it never does. */
export interface IssueWants {
  names: string[];
  says: RegExp[];
  never?: RegExp[];
}
/**
 * The App's issue that names every one of `names` in code, and why it falls short of what it must say, if it does.
 * With no such issue, the fault says so.
 */
export function issueFault(
  issues: readonly IssueFacts[],
  app: string,
  wants: IssueWants,
): { number?: number; fault?: string } {
  const named = wants.names.map((name) => `\`${name}\``).join(' and ');
  const issue = issues.find((i) => i.author === app && wants.names.every((name) => i.body.includes(`\`${name}\``)));
  if (!issue) return { fault: `no issue of the App's names ${named}` };
  const lacks = wants.says.filter((words) => !words.test(issue.body));
  if (lacks.length)
    return {
      number: issue.number,
      fault: `issue #${issue.number} does not say ${lacks.map((w) => w.source).join(', ')}`,
    };
  const has = (wants.never ?? []).filter((words) => words.test(issue.body));
  if (has.length)
    return { number: issue.number, fault: `issue #${issue.number} says ${has.map((w) => w.source).join(', ')}` };
  return { number: issue.number };
}
/** Whether an issue's title is the pin watch's for a move of this name: to a target, or off a line no longer built. */
export const issueOfMove = (title: string, name: string) =>
  title.startsWith(`Move ${name} to `) || title.startsWith(`Move ${name} off `);

// ── Dependabot's pull request for a pin the App moved ───────────────────────────────────────────────────────────────

/** How the worker's comment begins as it closes Dependabot's pull request for versions `main` already has. */
export const DUPLICATE_CLOSED = '`main` already has every version this moves';
export interface DuplicateFacts {
  number: number;
  /** `open`, `closed` (unmerged) or `merged`. */
  state: string;
  closedAt?: string | undefined;
  closedBy?: string | undefined;
  /** When it was last opened: its creation, or a later reopening. */
  openedAt: string;
  comments: { author: string; body: string; at: string }[];
}
/**
 * Dependabot's pull request for a pin the App's move also makes (test 22): open when that move merged, then closed by
 * the App, with a comment that begins as the worker's does and names the merge, by its pull request or its commit.
 * Dependabot closes its own once it sees `main` has the version, and may get there first: that is no fault of the
 * worker's, and no proof of it either, so the line says which happened and does not pass.
 */
export function duplicateVerdict(o: {
  pull: DuplicateFacts | undefined;
  app: string;
  /** The App's move that put the versions on `main`, once it has merged. */
  merge: { number: number; commit: string; at: string } | undefined;
}): { pass: boolean; why: string } {
  const fail = (why: string) => ({ pass: false, why });
  const { pull, merge } = o;
  if (!pull)
    return fail(
      "no pull request of Dependabot's for it: nothing for the worker to close (the set-up's, not the code's)",
    );
  const tag = `Dependabot's #${pull.number}`;
  if (pull.state === 'merged') return fail(`${tag} merged, and the App's move was to make it`);
  if (!merge) return fail(`${tag} is ${pull.state}; the App's move has not merged`);
  if (pull.openedAt > merge.at || (pull.closedAt && pull.closedAt < merge.at))
    return fail(`${tag} was not open when #${merge.number} merged: nothing for the worker to close (the set-up's)`);
  if (pull.state === 'open') return fail(`${tag} still open after #${merge.number} merged`);
  if (pull.closedBy !== o.app)
    return fail(
      `no verdict: ${tag} was closed by ${pull.closedBy ?? 'nobody known'}, before the worker closed it; no fault of the worker's, and no proof of it`,
    );
  const said = pull.comments.find((c) => c.author === o.app && c.body.trimStart().startsWith(DUPLICATE_CLOSED));
  if (!said) return fail(`${tag} closed by the App with no comment that begins "${DUPLICATE_CLOSED}"`);
  if (!said.body.includes(`#${merge.number}`) && !said.body.includes(merge.commit.slice(0, 7)))
    return fail(
      `${tag} closed by the App, and its comment names neither #${merge.number} nor ${merge.commit.slice(0, 7)}`,
    );
  return { pass: true, why: `${tag} closed by the App once #${merge.number} merged, its comment naming the merge` };
}
/** Why a pull request of Dependabot's that `main` does not have the versions of was not left alone, if it was not. */
export function leftAloneFault(pulls: readonly DuplicateFacts[], app: string): string | undefined {
  if (!pulls.length)
    return "no pull request of Dependabot's that main lacks the versions of, to be left alone (the set-up's)";
  const closed = pulls.find((p) => p.state !== 'open' && p.closedBy === app);
  return closed ? `Dependabot's #${closed.number}, whose versions main lacks, was closed by the App` : undefined;
}

// ── A ticket that must close with no change of its own ──────────────────────────────────────────────────────────────

export interface TicketFacts {
  workItem: string;
  takenAt?: string | undefined;
  held?: string | undefined;
  closed?: { outcome: string; reason: string } | undefined;
  failures?: number | undefined;
  events: string[];
  issue?: { number: number; state?: string; reason?: string; by?: string } | undefined;
}
/**
 * Why a ticket for a move `main` already has did not end as it must (W3's second, W3b's own): taken, never held,
 * closed with the outcome and the reason asked, no step failed, and its issue closed as completed by the App.
 */
export function ticketFault(
  ticket: TicketFacts,
  wants: { closes: string; reason: RegExp },
  app: string,
): string | undefined {
  const tag = `#${ticket.workItem}`;
  if (!ticket.takenAt) return `${tag} never taken`;
  if (ticket.held) return `${tag} held for Martin: ${ticket.held}`.slice(0, 420);
  if (!ticket.closed) return `${tag} not closed: ${ticket.events.join(' ') || 'no event'}`.slice(0, 420);
  if (ticket.closed.outcome !== wants.closes || !wants.reason.test(ticket.closed.reason))
    return `${tag} closed ${ticket.closed.outcome}: ${ticket.closed.reason}`.slice(0, 420);
  if (ticket.failures) return `${tag} closed ${ticket.closed.outcome} after ${ticket.failures} failed steps`;
  const issue = ticket.issue;
  if (!issue) return `${tag} closed ${ticket.closed.outcome} with no issue of its own`;
  if (issue.state !== 'closed' || issue.reason !== 'completed' || issue.by !== app)
    return `${tag}'s issue #${issue.number} is ${issue.state} (${issue.reason ?? 'no reason'}, by ${issue.by ?? 'nobody'}), not closed as completed by the App`;
  return undefined;
}

// ── A target that moves on after the pull request opened ────────────────────────────────────────────────────────────

/** A pinned copy of a package in pnpm's lockfile, as its `packages:` key line: two spaces, `<name>@<version>:`. */
export const lockfileKey = (name: string, version: string) => `  ${name}@${version}:`;
/**
 * Why a move whose target the scan raised after its pull request opened (test 21) did not take the new target into
 * the same pull request and issue, or nothing when it did. `first` is the target the first scan named and `later` the
 * next one's. A first issue that never named `first` is the set-up's fault (the staged exception was not in force), and
 * a pull request that merged before the later scan reached the line shows nothing either way.
 */
export function newerFault(o: {
  number: number;
  first: string;
  later: string;
  /** The issue's body when the pull request opened, and now. */
  issueAtOpen: string | undefined;
  issueNow: string | undefined;
  /** The pull request's head when the later scan was given to the line, and now. */
  headAtOpen: string | undefined;
  headNow: string;
  mergedAt?: string | undefined;
  /** When the later scan's target reached the line: the sense restarted on it. */
  toldAt: string | undefined;
  /** The lockfile's key lines the pull request's diff adds. */
  adds: string[];
  name: string;
}): string | undefined {
  const tag = `#${o.number}`;
  // A version as a word of its own, in code or not: `1.15.6`, never the middle of 11.15.60.
  const names = (text: string, version: string) =>
    new RegExp(`(?<![\\d.])${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d.])`).test(text);
  if (o.issueAtOpen === undefined) return `${tag}: its issue was not read when it opened`;
  if (!names(o.issueAtOpen, o.first))
    return `no verdict: the issue did not name ${o.first} when ${tag} opened, so the first scan's target was not the staged one (is the exception in force?)`;
  if (!o.toldAt) return `${tag}: the later scan never reached the line`;
  if (o.mergedAt && o.mergedAt < o.toldAt)
    return `no verdict: ${tag} merged at ${o.first} before the later scan reached the line`;
  if (o.headNow === o.headAtOpen)
    return `${tag} is still at ${o.headNow.slice(0, 7)}, its head before the target moved`;
  if (!o.adds.includes(lockfileKey(o.name, o.later)))
    return `${tag} does not move ${o.name} to ${o.later} (it adds ${o.adds.map((l) => l.trim()).join(', ') || 'no copy of it'})`;
  if (o.adds.includes(lockfileKey(o.name, o.first))) return `${tag} still moves a copy of ${o.name} to ${o.first}`;
  if (o.issueNow === undefined) return `${tag}: its issue was not read at the end`;
  if (!names(o.issueNow, o.later)) return `${tag}'s issue does not name ${o.later}`;
  if (names(o.issueNow, o.first)) return `${tag}'s issue still names ${o.first}`;
  return undefined;
}

// ── The store restarting under a report ─────────────────────────────────────────────────────────────────────────────

/**
 * A report left through the app's widget as the store restarts (W5): the store was back, no worker logged an error
 * from the report on, and the report is in the inbox once.
 */
export function restartVerdict(o: {
  /** The app's answer to the report: 202 when it took it. */
  posted: number;
  /** Whether the store's pod was deleted and came back Ready. */
  restarted: boolean;
  /** Each worker's error lines since the report, as `<pod>: <count> (<first>)`. */
  errors: string[];
  /** The inbox's rows for the report, at the end of the watch. */
  inbox: number;
  /** How long the report took to reach the inbox, in seconds. */
  arrivedS?: number | undefined;
}): { pass: boolean; why: string } {
  const fail = (why: string) => ({ pass: false, why });
  if (o.posted !== 202) return fail(`the app answered the report ${o.posted}, not 202: no report to wait for`);
  if (!o.restarted) return fail('the store did not restart under it, or did not come back');
  if (o.inbox === 0) return fail('the report never reached the inbox');
  if (o.inbox > 1) return fail(`the report is in the inbox ${o.inbox} times, not once`);
  if (o.errors.length)
    return fail(`the report arrived once, but a worker logged an error: ${o.errors.join('; ')}`.slice(0, 420));
  return {
    pass: true,
    why: `the store restarted under the report; in the inbox once, after ${o.arrivedS ?? '?'} s; no worker logged an error`,
  };
}
