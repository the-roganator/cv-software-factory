/**
 * What Patching's rows say, in the factory's own words: each row's state and who moves it, why it is where it is, the
 * one way forward on GitHub and what it does, what failed and its run, and what happens if it is left. Only what GitHub
 * already shows of a pull request or issue, never a log, a tool's output, or a pull request's or Dependabot's text; a
 * check that failed by its name, its try and a link to its run. Kept apart from the sheet's component, plain
 * TypeScript, so Node tests the words directly.
 *
 * Martin, signed in, reads "you"; everyone else reads "Martin". A visitor's lockfile row the public view withholds says
 * only that it waits on Martin, never what for, and has no number.
 */
import { capital, count, plural, when } from '../format.ts';
import type { PatchGroup, PatchingRow, Pull } from '../projection/patching.ts';
import { REPOSITORIES } from '../repositories.ts';

/** The glyphs these words come with, each one of `Glyph.tsx`'s. */
type Mark = 'check' | 'dash' | 'ring';

/** Who a word names: Martin, signed in, reads "you"; everyone else reads "Martin". */
export interface Who {
  martin: boolean;
}
const you = ({ martin }: Who) => (martin ? 'you' : 'Martin');
const You = ({ martin }: Who) => (martin ? 'You' : 'Martin');
const your = ({ martin }: Who) => (martin ? 'your' : 'his');
const Your = ({ martin }: Who) => (martin ? 'Your' : 'Martin’s');
const yours = ({ martin }: Who) => (martin ? 'yours' : 'Martin’s');

/** A repository's page on GitHub. */
export const repoUrl = (repository: string | undefined) => `https://github.com/${repository ?? REPOSITORIES.factory}`;
/** A pull request's or issue's page. */
const pullUrl = (repository: string | undefined, pull: Pull) =>
  `${repoUrl(repository)}/${pull.kind === 'issue' ? 'issues' : 'pull'}/${pull.number}`;
/** A run's page, built from its id, never from a link the event gives. */
export const runUrl = (repository: string | undefined, run: number) => `${repoUrl(repository)}/actions/runs/${run}`;

/** Each group's heading, Martin's and a visitor's, the line under it, and its rows' state word. */
export const GROUP_WORDS: Record<PatchGroup, { mine: string; his: string; line: string; word: string }> = {
  approve: {
    mine: 'Yours to approve',
    his: 'Martin’s to approve',
    line: 'Ready on GitHub, and waiting for a yes.',
    word: 'Approve',
  },
  bench: {
    mine: 'Waits for your bench run',
    his: 'Waits for Martin’s bench run',
    line: 'A move of the agent loop itself: it goes once a bench run on Claude passes on its branch.',
    word: 'Run the bench',
  },
  held: {
    mine: 'Held by you',
    his: 'Held by a person',
    line: 'Someone stopped it on GitHub, and it waits until that is undone.',
    word: 'Held',
  },
  stuck: {
    mine: 'Tried and stopped',
    his: 'Tried and stopped',
    line: 'The factory made the move, and something stopped it.',
    word: 'Stopped',
  },
  hand: {
    mine: 'Yours to do by hand',
    his: 'Martin’s to do by hand',
    line: 'Nothing the factory may write: a workflow, the cluster, a line no longer built.',
    word: 'By hand',
  },
  martin: {
    mine: 'Waits on Martin',
    his: 'Waits on Martin',
    line: 'A package in a lockfile, withheld while it has an open finding.',
    word: 'Waits on Martin',
  },
};

/** How the card counts each group: one and many. */
export const GROUP_COUNTS: Record<PatchGroup, [one: string, many: string]> = {
  approve: ['to approve', 'to approve'],
  bench: ['bench run', 'bench runs'],
  held: ['held by you', 'held by you'],
  stuck: ['tried and stopped', 'tried and stopped'],
  hand: ['to do by hand', 'to do by hand'],
  martin: ['waiting on Martin', 'waiting on Martin'],
};

/** Whether a row is a lockfile's whose package the public view withholds. */
export const withheld = (row: PatchingRow) =>
  row.source.kind === 'move' && row.source.lockfile && row.name === undefined;

const isApp = (row: PatchingRow) => row.repository === REPOSITORIES.app;

/** A withheld lockfile row's name. */
export const lockfileName = (row: Pick<PatchingRow, 'repository'>) =>
  `A package in ${row.repository === REPOSITORIES.app ? 'the app’s' : 'the factory’s'} lockfile`;

/** Who moves a row, as its pill says it, before its number. */
export function routeWords(row: PatchingRow, who: Who): string {
  const { source, pull } = row;
  if (row.state.kind === 'waits' && row.state.why === 'withheld') return 'Martin’s approval';
  if (source.kind === 'unlisted-image' || source.kind === 'unscanned-digest' || source.kind === 'not-running')
    return `${Your(who)} cluster`;
  const cluster = source.kind === 'move' && source.lane === 'cluster';
  if (pull) {
    if (pull.kind === 'dependabot') return 'Dependabot';
    if (pull.kind === 'issue') {
      if (pull.issue === 'bench') return who.martin ? 'Your bench run' : 'Martin’s approval';
      return pull.issue === 'cluster' || cluster ? `${Your(who)} cluster` : 'An issue';
    }
    if (cluster) return `${Your(who)} cluster`;
    if (row.state.kind === 'waits' && ['level', 'held', 'changes-requested'].includes(row.state.why))
      return `${Your(who)} approval`;
    return 'The worker';
  }
  if (source.kind === 'waiting') return source.why === 'content' ? 'The worker' : 'None yet';
  switch (source.lane) {
    case 'line':
      return 'The line';
    case 'worker':
      return 'The worker';
    case 'cluster':
      return `${Your(who)} cluster`;
    case 'issue':
      return 'An issue';
    case 'none':
      return 'None yet';
  }
}

/** The number its pill names: its pull request's or issue's, or the line's work item's; none where it is withheld. */
export const pillNumber = (row: PatchingRow): number | string | undefined => row.pull?.number ?? row.link?.number;

/** A row's state, as a glyph and a word: a ring for waiting or in flight, a tick for done, a dash for nothing to do. */
export function stateWords(row: PatchingRow, who: Who): [word: string, tone: string, glyph: Mark] {
  const { state } = row;
  switch (state.kind) {
    case 'waits':
      return [GROUP_WORDS[state.group].word, 'attn', 'ring'];
    case 'opened':
      return ['Opened', 'signal', 'ring'];
    case 'checks':
      return ['Checks running', 'signal', 'ring'];
    case 'queue':
      return ['In the merge queue', 'signal', 'ring'];
    case 'stage':
      return [`In ${state.stage}`, 'signal', 'ring'];
    case 'lane':
      return [routeWords(row, who), 'signal', 'ring'];
    case 'day':
      return ['Waits its day', 'faint', 'ring'];
    case 'none':
      return ['Nothing to move to', 'faint', 'dash'];
    case 'merged':
      return ['Merged', 'ok', 'check'];
    case 'gone':
      return ['No longer listed', 'faint', 'dash'];
    case 'closed':
      return ['Closed', 'faint', 'dash'];
  }
}

/** What the Clears column says where it has no counts to draw, or none worth drawing. */
export function clearsNote(row: PatchingRow): string | undefined {
  const { source } = row;
  if (source.kind === 'waiting' && source.why === 'no-better') return 'no target chosen';
  if (source.kind === 'move' && source.unbuilt) return 'nothing to move to';
  if (source.kind === 'move' && source.lane === 'none' && row.clears && countOf(row.clears) === 0)
    return 'nothing: no fix yet';
  if ((source.kind === 'move' || source.kind === 'waiting') && source.routine) return 'nothing: a routine update';
  return undefined;
}

/** The severities a count holds, those above zero: "2 High", "1 Critical and 4 High". */
function severitiesWords(c: { critical: number; high: number; medium: number; low: number; unknown: number }): string {
  const words = (
    [
      [c.critical, 'Critical'],
      [c.high, 'High'],
      [c.medium, 'Medium'],
      [c.low, 'Low'],
      [c.unknown, 'unrated'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, s]) => `${count(n)} ${s}`);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? 'nothing');
}

const countOf = (c: { critical: number; high: number; medium: number; low: number; unknown: number }) =>
  c.critical + c.high + c.medium + c.low + c.unknown;

/** The review gate's rule at a head, as a row says it passed by it. */
function ruleWords(pull: Pull, who: Who): string | undefined {
  switch (pull.rule) {
    case 'move':
      return 'as the scan’s move';
    case 'major':
      return 'as a major';
    case 'exact-pin':
      return 'as an exact pin';
    case 'low-risk':
      return 'as low-risk';
    case 'lights-out':
      return 'at Lights-out';
    case 'martin-approved-head':
      return `by ${your(who)} approval of its head`;
    case 'martin-opened':
      return `as ${yours(who)}`;
    case 'held':
    case undefined:
      return undefined;
  }
}

/** "#1342", or "it" where the pull request has no number to name. */
const named = (pull: Pull | undefined) => (pull?.number !== undefined ? `#${pull.number}` : 'it');
/** "The worker opened #1342" or "Dependabot opened #1350". */
const opener = (pull: Pull) => `${pull.kind === 'dependabot' ? 'Dependabot' : 'The worker'} opened ${named(pull)}`;

/** A refusal's kind, as a row says the pin step refused it: never pnpm's words. */
const REFUSAL: Record<NonNullable<Pull['refusal']>, string> = {
  young: 'the release is younger than the minimum age this repository gives one',
  provenance: 'the release is a provenance downgrade, published without the attestation the one before it had',
  script: 'the release has an install script this repository does not allow',
  override: 'a copy of it stays below the target, as what depends on it admits nothing newer',
  resolved: 'pnpm resolved a newer release than the scan listed, which has not waited a routine update’s days',
  lock: 'mise could not lock the release',
  other: 'for a reason of its own',
};

/** What to do about a refusal, by its kind. */
const REFUSAL_DOES: Record<NonNullable<Pull['refusal']>, string> = {
  young: 'Leave it: the worker makes the move on a later day’s scan, once the release is old enough.',
  provenance:
    'Leave it: a later release with its provenance is taken by itself, and closes the issue. Or allow it in `pnpm-workspace.yaml`, with its reason.',
  script: 'Allow it in `pnpm-workspace.yaml`, with its reason, or wait for a release that needs none.',
  override:
    'Wait for a release of what depends on it, which the worker then makes, or add an override in `pnpm-workspace.yaml`, with its reason.',
  resolved: 'Leave it: the worker makes the move on a later day’s scan, once the scan lists that release.',
  lock: 'Leave it for a later run, or move it by hand: the scan’s next run sees it.',
  other: 'Leave it for a later run, or move it by hand: the scan’s next run sees it.',
};

/** The sense's rows, why each waits. */
const RUNNING_WHY = {
  'unlisted-image':
    'The sense found a pod running an image that no pin names, so the daily scan never sees it. It came from outside a merge: a pod started by hand, or by something the list does not read.',
  'unscanned-digest':
    'A pod runs a reference the list has, at a digest the scan never read, such as a tag rebuilt upstream since: what runs there is not what was scanned.',
  'not-running': '',
} as const;

/** Why a row is where it is: one sentence or a few, in the factory's own words. */
export function whyWords(row: PatchingRow, who: Who): string {
  const { source, pull, state } = row;
  if (source.kind === 'unlisted-image' || source.kind === 'unscanned-digest') return RUNNING_WHY[source.kind];
  if (source.kind === 'not-running')
    return `main pins it, and ${your(who)} cluster runs another of the same image: Argo CD has not applied the pin yet, or, for k3s, only the cluster’s own command does.`;
  const isDone = state.kind === 'merged' || state.kind === 'gone' || state.kind === 'closed';
  if (withheld(row)) {
    return row.waits
      ? 'Its package is withheld while it has an open finding, and so is what it waits for. Martin sees both, signed in.'
      : isDone
        ? 'A lockfile’s package is withheld, as every vulnerable one is, and so is what it clears. Martin sees both, signed in.'
        : 'A lockfile’s package is withheld, as every vulnerable one is, and so are its versions. Martin sees both, signed in.';
  }
  if (isDone) return doneWords(row, who);
  const routine = (source.kind === 'move' || source.kind === 'waiting') && source.routine;
  const leaves = row.leaves
    ? ` It stays within its major, and leaves ${severitiesWords(row.leaves)} that only the next major clears: that major is listed on a later scan, and the deadline here is the earliest of what it clears or leaves.`
    : '';
  const rule = pull ? ruleWords(pull, who) : undefined;
  const passed = pull && rule ? `the review gate passed ${named(pull)} ${rule}` : undefined;
  // After "The worker opened #1342", the gate passed it.
  const passedIt = pull && rule ? `the review gate passed it ${rule}` : undefined;
  if (state.kind === 'waits') {
    switch (state.why) {
      case 'level':
        return `The review gate passed ${named(pull)} as a major: exactly the scan’s move, and a major. Below Lights-out a major waits for ${you(who)}; at Lights-out it would merge by itself.`;
      case 'held':
        return `The review gate held ${named(pull)} for ${your(who)} approval: it changes more than the scan’s move, or a file only ${you(who)} approve${who.martin ? '' : 's'}.`;
      case 'martin':
        return `${routine ? 'A routine update of a third-party action: no finding asks for it. ' : ''}Dependabot opened ${named(pull)}, and a third-party action’s pin is ${yours(who)} to merge at every level.`;
      case 'bench':
        return `The agent SDK is the loop every agent step runs in, and the tests replay cassettes, so a change in it shows only on a live step. A fix rated below Critical is an issue of the App’s, ${named(pull)}, with its target and deadline, until a bench run on Claude${row.to ? ` with ${row.to}` : ''} passes, which is ${yours(who)} to run. A Critical fix would move by itself.`;
      case 'reverted':
        return `Its merge was undone on main, so the factory leaves it unmade until its target changes. Issue ${named(pull)} says so.${row.held.length ? ` Its pull request makes ${row.held.length === 1 ? 'another move' : `${count(row.held.length)} other moves`} with it, so it holds ${row.held.length === 1 ? 'that one' : 'them'} with it.` : ''}`;
      case 'with-reverted':
        return `It is made together with a move whose merge was undone on main, in the same files, so it waits until that move’s target changes. Issue ${named(pull)} says so.`;
      case 'changes-requested':
        return `${You(who)} asked for changes on ${named(pull)}, so the review gate holds it at this head and every later one until ${you(who)} approve${who.martin ? '' : 's'} it or dismiss${who.martin ? '' : 'es'} ${your(who)} review.`;
      case 'dequeued':
        return `A person took ${named(pull)} out of the merge queue at its head, and the worker never queues that head again. A new head, or adding it to the queue by hand, ends the hold.`;
      case 'label':
        return `Someone took the App’s label off ${named(pull)}, so the worker no longer carries it.`;
      case 'closed':
        return `${You(who)} closed ${named(pull)} without a merge, so the worker does not open it again for the same edits. A new target opens it again.`;
      case 'checks-spent':
        return `${passed ? capital(passed) : opener(pull as Pull)}, and its required checks failed ${pull?.checks ? `on each of its ${count(pull.checks.of)} tries` : 'on every try'}, so the worker stopped trying. What failed is in the run.`;
      case 'queue-spent':
        return `${passed ? capital(passed) : opener(pull as Pull)}, and the merge queue took it out on each try, so the worker stopped adding it.`;
      case 'conflict':
        return `${named(pull)} conflicts with main, so the merge queue cannot take it.`;
      case 'refused':
        return `${routine ? 'A routine update the pin step refused' : 'The scan’s pin step refused it'}: ${REFUSAL[pull?.refusal ?? 'other']}. The worker made it an issue, ${named(pull)}, which says the kind of refusal, never the tool’s words.`;
      case 'branch-held':
        return `A pull request the App did not open stands on its branch, so the worker refused the move and opened issue ${named(pull)}. It never writes a branch it does not own.`;
      case 'open-refused':
        return `The worker committed the move to its branch, and GitHub refused the pull request from it. Issue ${named(pull)} says so; the worker tries again each pass.`;
      case 'history-unread':
        return `Its branch has more closed pull requests than the worker reads, so it cannot tell whether ${you(who)} closed this move or undid its merge, and makes nothing there. Issue ${named(pull)} says so.`;
      case 'no-better':
        return 'A fix exists, but no release is better than the pin: none the scan tried has fewer findings at the worst severity. It lists no target, so nothing moves.';
      case 'cluster':
        return `Only the cluster’s own command applies a new k3s: make upgrade-cluster, with the line stopped. No pull request can show it works.${pull ? ` ${pull.kind === 'issue' ? 'Issue' : 'Pull request'} ${named(pull)} has the pin and the target.` : ''}`;
      case 'workflow':
        return `A workflow’s pin: workflow pins are ${yours(who)} at every level, so the factory’s App writes none. Issue ${named(pull)} has the pin and the target.`;
      case 'none':
        return `A line nobody builds any more: its tag is no version and its image is over 180 days old, so there is nothing to move to, and its findings count under No fix yet.${pull ? ` The worker opened issue ${named(pull)}.` : ''}`;
      case 'other':
        return `It needs more than its pins’ lines written, so the factory’s App writes none of it. Issue ${named(pull)} has the pins and the target.`;
      case 'issue':
        return 'No pull request of the factory’s App can write it: the Makefile pins it, or a workflow does. A person moves it.';
      case 'withheld':
      case 'unlisted-image':
      case 'unscanned-digest':
      case 'not-running':
        return '';
    }
  }
  const stopped = row.stopped ? ' The line is stopped, so the worker queues it once the line starts again.' : '';
  switch (state.kind) {
    case 'opened':
      return `${pull ? opener(pull) : 'It opened'}${passedIt ? `, and ${passedIt}` : pull?.hold === 'verdict' ? ', and the review gate has not judged its head yet' : ''}.${routine ? ' A routine update, opened apart from the fixes, so it never holds one up.' : ''}${stopped}${leaves}`;
    case 'checks':
      return `${pull ? opener(pull) : 'It opened'}${passedIt ? ` and ${passedIt}` : ''}. Its checks are running${pull?.checks ? `, try ${pull.checks.try} of ${pull.checks.of}` : ''}; it merges by itself once they pass.${stopped}${leaves}`;
    case 'queue':
      return `${passed ? capital(passed) : pull ? opener(pull) : 'It opened'}, its checks passed, and the worker added it to the merge queue.${leaves}`;
    case 'day':
      return `A fix exists, but the scan first saw its content less than a day ago, and an image or chart waits a day before it is a move, so a release pulled in its first hours never runs here. It is listed ${row.until !== undefined ? `from ${when(row.until)}` : 'tomorrow'}.`;
    case 'none':
      return row.leaves
        ? `Nobody publishes a version without its ${plural(countOf(row.leaves), 'finding')} yet (${severitiesWords(row.leaves)}), so they are counted under No fix yet. The scan looks again each day; a fix starts its deadline.`
        : 'Nobody publishes a version without its findings yet, so they are counted under No fix yet. The scan looks again each day; a fix starts its deadline.';
    case 'stage':
    case 'lane':
      if (source.kind === 'move' && source.lane === 'line')
        return row.link
          ? `The app’s move goes down the line as a work item, #${row.link.number}: its pins are written, then its gates and review, as any change.`
          : 'The app’s moves are the line’s: it takes one as a work item, as it takes any ticket.';
      return `${source.kind === 'move' && source.major ? 'Its fix is a major one. ' : ''}The worker opens its pull request on its next pass, and the review gate judges it there.${leaves}`;
    case 'merged':
    case 'gone':
    case 'closed':
      return '';
  }
}

/** What a row of Done says of how it was done. */
function doneWords(row: PatchingRow, who: Who): string {
  const { pull, on } = row;
  const day = on === undefined ? '' : ` on ${when(on)}`;
  if (!pull) return `The scan stopped listing it${day}, and no pull request the factory reads merged it.`;
  if (pull.state === 'merged') {
    const owner = pull.kind === 'dependabot' ? 'Dependabot’s' : 'the worker’s';
    return row.source.kind === 'move' && row.source.routine
      ? `A routine update: ${owner} ${named(pull)} merged${day}.`
      : `${capital(owner)} ${named(pull)} merged${day}.`;
  }
  if (pull.kind === 'issue') return `Issue ${named(pull)} closed${day}.`;
  if (pull.closedByPerson)
    return `${You(who)} closed ${named(pull)}${day} without a merge, so the worker does not open it again for the same edits.`;
  return `The worker closed ${named(pull)}${day}: the scan no longer lists it at that target.${row.goesOn ? ` The move goes on under its new target, ${row.goesOn}.` : ''}`;
}

/** The one way forward, on GitHub: a verb, where it goes, and what it does there. */
export interface Way {
  verb: 'Review' | 'Open' | 'Merge';
  href: string;
  /** What it names to a screen reader. */
  what: string;
  does: string;
}

/** A row's way forward, for a row that waits on Martin, where it has a pull request, an issue or a run to open. */
export function wayOf(row: PatchingRow): Way | undefined {
  const { state, pull, repository } = row;
  if (state.kind !== 'waits') return undefined;
  if (state.why === 'no-better')
    return {
      verb: 'Open',
      href: row.run,
      what: 'its scan’s run',
      does: 'Read which candidates it tried. Pin one by hand in a pull request, or except the finding in `policy/vulnerabilities.ts` while no release fixes it cleanly.',
    };
  if (!pull || pull.number === undefined || state.why === 'withheld') return undefined;
  const at = (verb: Way['verb'], does: string): Way => ({
    verb,
    href: pullUrl(repository, pull),
    what: `#${pull.number}`,
    does,
  });
  switch (state.why) {
    case 'level':
    case 'held':
      return at('Review', 'Approve its head commit there: the worker then adds it to the merge queue.');
    case 'martin':
      return at(
        'Review',
        `Merge it there once its checks pass.${row.deadline === undefined ? ' Nothing is due: it can wait for a quiet moment.' : ''}`,
      );
    case 'bench':
      return at('Open', `Run the bench on Claude${row.to ? ` with ${row.to}` : ''}, then move it as the issue says.`);
    case 'reverted':
    case 'with-reverted':
      return at(
        'Open',
        'Put its merge back on main, or move it in a pull request of your own. A new target makes it again by itself.',
      );
    case 'changes-requested':
      return at('Review', 'Approve it, or dismiss your review: the worker then queues it as the scan’s move.');
    case 'dequeued':
      return at('Open', 'Add it to the merge queue there once you are content, or push a new head.');
    case 'label':
      return at('Open', 'Merge or close it there yourself, or put the App’s label back.');
    case 'closed':
      return at('Open', 'Reopen it there, or leave it: a new target opens a new one by itself.');
    case 'checks-spent':
      return at(
        'Open',
        'Read the run. Run it again there if it was the runner, or put the cause right on its branch: the worker queues it once its checks pass.',
      );
    case 'queue-spent':
      return at(
        'Open',
        'Read why the queue took it out there, put it right on its branch, or add it to the queue by hand.',
      );
    case 'conflict':
      return at(
        'Open',
        'Put the conflict with main right on its branch there: the worker queues it once it merges cleanly.',
      );
    case 'refused':
      return at('Open', REFUSAL_DOES[pull.refusal ?? 'other']);
    case 'branch-held':
      return at('Open', 'Close the pull request that stands on its branch: the next pass makes the move.');
    case 'open-refused':
      return at('Open', 'Read the issue: the worker tries again each pass, and closes it once the pull request opens.');
    case 'history-unread':
      return at('Open', 'Move it in a pull request of your own. The issue closes once the next scan finds it moved.');
    case 'cluster':
      return at(
        pull.kind === 'issue' ? 'Open' : 'Merge',
        'Run make upgrade-cluster with the line stopped, and merge the pin once every Application is Synced and Healthy.',
      );
    case 'workflow':
      return at('Open', 'Move it in a pull request of your own. The issue closes once the next scan finds it moved.');
    case 'none':
      return at('Open', 'Remove the line, or build it again from a tag that moves.');
    case 'other':
    case 'issue':
      return at('Open', 'Move it in a pull request of your own: the scan’s next run sees it.');
    case 'unlisted-image':
    case 'unscanned-digest':
    case 'not-running':
      return undefined;
  }
}

/** What Martin does about a row that waits on him with no way forward to open: the sense's rows, a lane's own. */
export function whatToDo(row: PatchingRow): string | undefined {
  const { source } = row;
  if (source.kind === 'unlisted-image')
    return 'Nothing to merge: add the image to the list in a pull request, or delete the pod. The sense reads again when it starts, and each day.';
  if (source.kind === 'unscanned-digest')
    return 'Pin the digest that runs, or restart the pod onto the one the list names. The sense reads again when it starts, and each day.';
  if (source.kind === 'not-running')
    return 'Sync it in Argo CD, or for k3s run make upgrade-cluster with the line stopped. The row goes once the sense reads it running.';
  if (row.state.kind === 'waits' && row.state.why === 'cluster')
    return 'Run make upgrade-cluster, with the line stopped. It loses nothing in the store.';
  if (row.state.kind === 'waits' && (row.state.why === 'issue' || row.state.why === 'none'))
    return 'Move it by hand in a pull request: the App writes no Makefile or workflow.';
  return undefined;
}

/** What happens if a row that waits is left: the scan fails from its deadline, or nothing comes due. */
export function leftWords(row: PatchingRow): string {
  if (row.deadline === undefined)
    return row.pull?.kind === 'dependabot'
      ? 'Left as it is, nothing comes due. Dependabot keeps it up to date.'
      : 'Left as it is, nothing comes due.';
  const also = row.held.length
    ? `, for it and the ${row.held.length === 1 ? 'one' : count(row.held.length)} it holds`
    : '';
  return `Left as it is, the scan fails from ${when(row.deadline)}${also}.`;
}

/** What failed, for a row whose checks failed on every try, or why no target, for a pin no release is better than. */
export function failedOf(
  row: PatchingRow,
): { label: string; lines: { name: string; words: string; href: string }[] } | undefined {
  const { pull } = row;
  if (row.state.kind === 'waits' && row.state.why === 'no-better')
    return {
      label: 'Why no target',
      lines: [{ name: 'the scan’s judgement', words: 'no candidate better', href: row.run }],
    };
  const checks = pull?.checks;
  if (checks?.state !== 'failed' || checks.failed.length === 0) return undefined;
  return {
    label: 'What failed',
    lines: checks.failed.map((failed) => ({
      name: failed.name,
      words: `failed · try ${checks.try} of ${checks.of}`,
      href: runUrl(row.repository, failed.run),
    })),
  };
}

/** A finding's severity, as a row lists it. */
export const SEVERITY_WORD = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', unknown: 'Unrated' };

/** Whether the row is an app's, which its pin says. */
export { isApp };
