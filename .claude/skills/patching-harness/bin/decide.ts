/**
 * What the harness decides from what it has read, apart from the reading, so each decision is tested
 * (decide.test.ts): whether a scan's move is a routine one, whether a pull request must be read again, when a test's
 * failure is certain before its limit, how long "nothing after" is, and what the app's pins of the factory's workflows
 * say. Nothing here reads GitHub, the cluster or a file.
 */
import { createHash } from 'node:crypto';

// ── A scan's moves ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ListedMove {
  name: string;
  lane: string;
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
