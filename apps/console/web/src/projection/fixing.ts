/**
 * A fix's way through Build, Gates and Review, from its events: each attempt the coder pushed, what the gates and
 * the reviewer made of it and why it went back, and the review thread with the rules it cites. And the pictures for
 * the moments a fix waits on Martin: the pull request he is asked to merge, or what the mechanism that held it
 * judged, chosen by the cause the hold records.
 *
 * Every figure here is read from events the line writes; where an event does not say something (which finding a
 * later round answered), the console does not guess it.
 *
 * Three counts, each with its own word: a round is the coder's (one for each attempt it pushes, as the line counts
 * them), a review is the reviewer's (two at most), and a patch is anything the coder handed back that the scope fence
 * judged, pushed or refused.
 */
import type { PayloadOf, PublicEvent, Stage } from '@software-factory/events';
import { knownInScope, returnWords } from '@software-factory/events';
import { RULES } from './app.ts';
import { deployWaitsForMartin, type Hold, type ItemState, ofType, type ReleaseStop, stopsRelease } from './items.ts';
import type { Ended, Picture } from './reel.ts';
import { backWords, stopWait } from './release.ts';

type Review = PayloadOf<'review.submitted'>;
type GateRun = PayloadOf<'gate.finished'>;

/** One patch the coder pushed, and what became of it. */
export interface Attempt {
  attempt: number;
  /**
   * The pass it belongs to, from 1: a return to Plan or a reopening starts a new one, whose first round is round 1
   * again, so a round is known by its pass and its number together.
   */
  pass: number;
  /** The commit the gates ran on, once they started. */
  commit: string | undefined;
  /** How the coder came to it: a first patch with its failing test first or not, or its own session resumed. */
  how: 'tests first' | 'no new test' | 'resumed';
  files: number;
  added: number;
  removed: number;
  gates: AttemptGates | undefined;
  review: AttemptReview | undefined;
  /**
   * Why it went back to Build, when it did: the stage that sent it, and why in a few words. Declined, the coder
   * declined every suggestion it was sent back for and pushed nothing, so no attempt follows the return.
   */
  returned: { from: Stage; detail: string; declined?: true } | undefined;
}

interface AttemptGates {
  state: 'running' | 'passed' | 'failed';
  /**
   * While a run on a newer commit of the same push runs (main merged in): whether the run before it passed. Those gates
   * stand until it ends, as the line counts them, so the reviewer goes on meanwhile.
   */
  standing: boolean;
  /** The required checks finished so far: passed, and in all. */
  passed: number;
  total: number;
  failed: string[];
  /** The tests-first signal, not required: whether its tests failed on the base, and the figure its summary gives. */
  testsFirst: { failedOnBase: boolean; figure: string | undefined } | undefined;
  /** Every check's latest result on the attempt's commit. */
  runs: GateRun[];
}

interface AttemptReview {
  /** Which review it was: the first, or the second. */
  number: number;
  verdict: Review['verdict'];
  blocking: number;
  suggestions: number;
}

/** One review, as the reviewer posted it. */
export interface ThreadReview {
  /** Which review it was: the first, or the second. */
  number: number;
  at: number;
  /** The attempt it reviewed. */
  attempt: number | undefined;
  verdict: Review['verdict'];
  note: string;
  findings: Finding[];
}

export interface Finding {
  path: string;
  line: number;
  blocking: boolean;
  comment: string;
  /** The rule it cites, with its words where the console knows them. */
  rule: { number: number; title: string | undefined; text: string | undefined } | undefined;
  /** The spec's criterion it cites, in full. */
  criterion: { number: number; text: string | undefined } | undefined;
  /** Whether it cites the ticket: the spec or the change goes beyond what the ticket asks. */
  ticket: boolean;
}

/** The tests-first check, by the name its workflow gives it. It is a signal, not a required check. */
const isTestsFirst = (check: string) => /tests[ -]first$/i.test(check);

/** "2 of 2": the figure in a check's summary, where it gives one. */
const figureIn = (summary: string | undefined) => summary?.match(/\d+ of \d+/)?.[0];

/** Each patch the factory's coder pushed, in order, with its gates, its review and its return. */
export function attempts(item: ItemState): Attempt[] {
  const list: Attempt[] = [];
  let current: Attempt | undefined;
  let reviews = 0;
  let pass = 1;
  let suggestionsBack = false;
  const runs = new Map<string, GateRun>();
  const settle = () => {
    if (!current?.gates) return;
    const all = [...runs.values()];
    const required = all.filter((run) => run.required);
    const tests = all.find((run) => !run.required && isTestsFirst(run.check));
    current.gates = {
      ...current.gates,
      passed: required.filter((run) => run.conclusion !== 'failure').length,
      total: required.length,
      failed: required.filter((run) => run.conclusion === 'failure').map((run) => run.check),
      // The check passes when the change's new tests fail on the base, as a test written before its fix must: its
      // success is their failure there.
      testsFirst: tests && { failedOnBase: tests.conclusion === 'success', figure: figureIn(tests.summary) },
      runs: all,
    };
  };
  for (const event of item.events) {
    if (startsPass(event)) pass += 1;
    switch (event.type) {
      case 'pull-request.pushed': {
        // Dependabot's pull requests and Martin's are not the coder's attempts.
        if (event.actor !== 'coder') break;
        const { attempt, testsFirst, files } = event.payload;
        current = {
          attempt,
          pass,
          commit: undefined,
          how: attempt > 1 ? 'resumed' : testsFirst ? 'tests first' : 'no new test',
          files: files.length,
          added: files.reduce((n, f) => n + f.added, 0),
          removed: files.reduce((n, f) => n + f.removed, 0),
          gates: undefined,
          review: undefined,
          returned: undefined,
        };
        list.push(current);
        break;
      }
      case 'gates.started':
        // A run on a newer commit of the same push (main merged in) replaces the one before.
        if (!current) break;
        current.commit = event.payload.commit;
        current.gates = {
          state: 'running',
          standing: current.gates?.state === 'passed' || (current.gates?.state === 'running' && current.gates.standing),
          passed: 0,
          total: 0,
          failed: [],
          testsFirst: undefined,
          runs: [],
        };
        runs.clear();
        break;
      case 'gate.finished':
        if (current?.commit !== event.payload.commit) break;
        runs.set(event.payload.check, event.payload);
        settle();
        break;
      case 'gates.finished':
        if (current?.commit !== event.payload.commit || !current.gates) break;
        current.gates.state = event.payload.conclusion;
        current.gates.standing = false;
        break;
      case 'review.submitted': {
        reviews += 1;
        if (!current) break;
        const blocking = event.payload.findings.filter((f) => f.blocking).length;
        current.review = {
          number: reviews,
          verdict: event.payload.verdict,
          blocking,
          suggestions: event.payload.findings.length - blocking,
        };
        break;
      }
      case 'work.returned': {
        if (!current || event.payload.to !== 'build') break;
        current.returned = { from: event.payload.from, detail: returnWords(event.payload) };
        suggestionsBack = event.payload.suggestions !== undefined;
        break;
      }
      case 'suggestions.answered': {
        // A coder that declines every suggestion it was sent back for pushes nothing, and the approval stands: the
        // return has no attempt after it, so its pill says why. One that took any pushed a new attempt first.
        if (current?.returned && suggestionsBack && event.payload.declined.length === event.payload.suggestions) {
          current.returned.detail += ', declined';
          current.returned.declined = true;
        }
        suggestionsBack = false;
        break;
      }
    }
  }
  return list;
}

/**
 * What the rounds have in hand now, besides gates that are running, which the last round's own gates say. A return
 * sends the work into a round the coder has not pushed yet: its row is drawn at once, hollow, so the return's arc
 * lands on its Build. None follows a return once the work item has closed or left Build for a new pass, or one the
 * coder declined in full, as it pushes nothing.
 */
export interface RoundsNow {
  /** The round a return sent the work into, before the coder pushed it, and whether the coder is at work on it. */
  next: { attempt: number; building: boolean } | undefined;
  /** Whether the reviewer is at work on the last round. */
  reviewing: boolean;
}

/** What the rounds have in hand now: the stage the work item is in, while it is in progress there, as its card's segment that blinks says. */
export function roundsNow(item: ItemState, list: readonly Attempt[]): RoundsNow {
  const last = list.at(-1);
  const inHand = (stage: Stage) => item.stage === stage && item.outcome === 'in-progress';
  // A return to Plan or a reopening starts a new pass, whose first round is round 1 again: only this pass's own return
  // and push count.
  const pass = item.events.findLastIndex(startsPass);
  const since = (found: (event: PublicEvent) => boolean) => item.events.findLastIndex(found) > pass;
  const returnedNow = since((event) => event.type === 'work.returned' && event.payload.to === 'build');
  const pushedNow = since((event) => event.type === 'pull-request.pushed' && event.actor === 'coder');
  const next =
    last?.returned && !last.returned.declined && returnedNow && item.closedAt === undefined && item.stage === 'build'
      ? { attempt: last.attempt + 1, building: inHand('build') }
      : undefined;
  // The line records no start for a review, only the reviewer's call as it ends: a round whose gates passed is the
  // reviewer's from then, while the work item is in hand at Gates or Review, and stays so while a run on a newer commit
  // of the push runs, since the gates that passed stand until it ends.
  const reviewing =
    !!last &&
    pushedNow &&
    !last.returned &&
    !last.review &&
    (last.gates?.state === 'passed' || !!last.gates?.standing) &&
    (inHand('gates') || inHand('review'));
  return { next, reviewing };
}

/** Every review, with each finding's rule and criterion in full. */
export function reviewThread(item: ItemState, spec: PayloadOf<'spec.written'> | undefined): ThreadReview[] {
  let attempt: number | undefined;
  const reviews: ThreadReview[] = [];
  for (const event of item.events) {
    if (event.type === 'pull-request.pushed' && event.actor === 'coder') attempt = event.payload.attempt;
    if (event.type !== 'review.submitted') continue;
    const { verdict, note, findings } = event.payload;
    reviews.push({
      number: reviews.length + 1,
      at: Date.parse(event.ts),
      attempt,
      verdict,
      note,
      findings: findings.map((f) => {
        const criterion = f.criterion !== undefined ? spec?.criteria[f.criterion - 1] : undefined;
        return {
          path: f.path,
          line: f.line,
          blocking: f.blocking,
          comment: f.comment,
          ticket: f.ticket === true,
          rule:
            f.rule !== undefined
              ? { number: f.rule, title: RULES[f.rule]?.title, text: RULES[f.rule]?.text }
              : undefined,
          criterion:
            f.criterion !== undefined
              ? {
                  number: f.criterion,
                  text: criterion && `GIVEN ${criterion.given} WHEN ${criterion.when} THEN ${criterion.expect}`,
                }
              : undefined,
        };
      }),
    });
  }
  return reviews;
}

const coderPushes = (item: ItemState) => ofType(item, 'pull-request.pushed').filter((event) => event.actor === 'coder');

interface Refusal {
  patch: number;
  output: string;
  /** The paths it refused, from the fence's verdict on each file. */
  refused: string[];
}

/**
 * The coder's patches the scope fence refused since Martin last answered a hold, which is the count the line holds
 * at, each numbered among every patch the fence judged.
 */
function refusals(item: ItemState): Refusal[] {
  let patches = 0;
  let since: Refusal[] = [];
  for (const event of item.events) {
    if (event.type === 'pull-request.pushed' && event.actor === 'coder') patches += 1;
    if (event.type === 'hold.answered') since = [];
    if (event.type === 'action.refused' && event.payload.mechanism === 'scope-fence') {
      patches += 1;
      const refused = (event.payload.files ?? []).filter((file) => !file.allowed).map((file) => file.path);
      since.push({ patch: patches, output: event.payload.output, refused });
    }
  }
  return since;
}

/**
 * The picture for a fix that waits on Martin: the pull request he is asked to merge, or what the mechanism that held
 * it judged, by the hold's cause. Nothing for any other wait, or for a hold whose events lack what its picture shows:
 * the card then shows the evidence, and the hold's reason says why it waits.
 */
export function waitPicture(item: ItemState): Picture | undefined {
  const hold = item.hold;
  if (hold?.cause === 'deploy') return deployPicture(item);
  if (!hold || item.dependency) return undefined;
  switch (hold.cause) {
    case 'merge':
      return mergePicture(item);
    case 'scope':
      // The coder named the files it needs: the fence refused nothing, and the card's evidence names them.
      return hold.needs ? undefined : scopePicture(item);
    case 'tests-first':
      return testsPassPicture(item);
    case 'spend':
      return spendPicture(item, hold);
    case 'review':
    case 'beyond-ticket':
      return blockingPicture(item);
    default:
      return undefined;
  }
}

/**
 * A merged fix held for the deploy pull request that will carry it: the pull request it waits with, and the deploy
 * pull request's state, once the App has opened one.
 */
export function deployPicture(item: ItemState): Extract<Picture, { type: 'deploy' }> | undefined {
  if (item.hold?.cause !== 'deploy') return undefined;
  const merged = ofType(item, 'pull-request.merged').at(-1);
  const pushed = ofType(item, 'pull-request.pushed').at(-1)?.payload;
  const ended = endedSinceMerge(item);
  const deploy = item.deploy;
  return {
    type: 'deploy',
    pullRequest: pushed?.number ?? item.pullRequest,
    title: pushed?.title,
    merged: merged && {
      at: Date.parse(merged.ts),
      commit: merged.payload.commit,
      byMartin: merged.payload.by === 'martin',
    },
    ended,
    deploy: deploy && {
      pullRequest: deploy.pullRequest,
      state: deploy.state,
      ...(deploy.failed && { failed: deploy.failed }),
    },
    waitsForMartin: deployWaitsForMartin(item),
  };
}

/** A deploy pull request that carries a held fix, as the line recorded it: what the console says of it. */
type DeployRecord = Pick<PayloadOf<'deploy.changed'>, 'pullRequest' | 'state' | 'failed'>;

/** The checks that failed, in a few words: "e2e", "e2e and lint", "e2e, lint and 2 more". */
function failedWords(failed: readonly string[] | undefined): string {
  const [first, second, ...rest] = failed ?? [];
  if (!first) return 'a check';
  if (!second) return first;
  return rest.length ? `${first}, ${second} and ${rest.length} more` : `${first} and ${second}`;
}

/** What the console says of a deploy pull request in one state: each place's words, from its number and failed checks. */
interface DeployWording {
  /** For a row or a caption, after "Merged ·": "deploy #412’s checks running". */
  short: (n: number) => string;
  /** The line the waiting picture draws for it, and whether that line is done (a tick), to come (a ring) or not (a cross). */
  tick: (n: number, failed: string) => string;
  ok: boolean | undefined;
  /** Its card's kicker in Needs you. */
  kicker: string;
  /** The sheet's facts, after its link: "checks running". */
  fact: string;
  /** Its card's evidence in Needs you, after "Merged at 15:58.". */
  evidence: (n: number, failed: string) => string;
}

/**
 * The deploy pull request that carries a held fix, in the console's words, by its state; `none` is the pull request
 * still to come, while the image that carries the fix is built and signed. One table, so the row, the picture, Needs
 * you and the sheet cannot drift apart.
 */
const DEPLOY_WORDS: Record<DeployRecord['state'] | 'none', DeployWording> = {
  none: {
    short: () => 'waiting for its deploy pull request',
    tick: () => 'The next deploy pull request carries it, with its ticket and issue',
    ok: undefined,
    kicker: 'Its deploy is being built',
    fact: 'not open yet',
    evidence: () =>
      'The App opens the deploy pull request that carries it once its image is built and signed; merging that will be yours, on GitHub.',
  },
  checking: {
    short: (n) => `deploy #${n}’s checks running`,
    tick: (n) => `Deploy #${n} carries it; its checks are running`,
    ok: undefined,
    kicker: 'Its deploy’s checks are running',
    fact: 'checks running',
    evidence: (n) =>
      `Deploy #${n} carries it, and its checks are running; once they pass, merging it is yours, on GitHub.`,
  },
  passed: {
    short: (n) => `deploy #${n} ready to merge`,
    tick: (n) => `Deploy #${n} carries it, and its checks passed`,
    ok: true,
    kicker: 'Waiting for your deploy',
    fact: 'checks passed',
    evidence: (n) =>
      `Deploy #${n} carries it, and its checks passed: merging it is yours, on GitHub, and a release that carries it ends this wait by itself.`,
  },
  failed: {
    short: (n) => `deploy #${n}’s checks failed`,
    tick: (n, failed) => `Deploy #${n} carries it, and ${failed} failed on it`,
    ok: false,
    kicker: 'Its deploy’s checks failed',
    fact: 'checks failed',
    evidence: (n, failed) =>
      `Deploy #${n} carries it, and ${failed} failed on it. A newer build moves it on, and its checks run again.`,
  },
  merged: {
    short: (n) => `deploy #${n} merged, waiting for Argo CD`,
    tick: (n) => `Deploy #${n} merged; its release starts once Argo CD syncs`,
    ok: true,
    kicker: 'Its deploy merged',
    fact: 'merged',
    evidence: (n) =>
      `Deploy #${n}, which carries it, merged; its release starts once Argo CD syncs, and ends this wait by itself.`,
  },
  closed: {
    short: (n) => `deploy #${n} closed, waiting for the next`,
    tick: (n) => `Deploy #${n} was closed unmerged; the next build’s carries it`,
    ok: false,
    kicker: 'Its deploy was closed',
    fact: 'closed unmerged',
    evidence: (n) => `Deploy #${n} was closed unmerged; the next build’s deploy pull request carries it.`,
  },
};

/** Where the deploy pull request that carries a held fix stands, in each place's words (`DEPLOY_WORDS`). */
export function deployWords(deploy: DeployRecord | undefined): {
  short: string;
  tick: string;
  ok: boolean | undefined;
  kicker: string;
  fact: string;
  evidence: string;
} {
  const words = DEPLOY_WORDS[deploy?.state ?? 'none'];
  const n = deploy?.pullRequest ?? 0;
  const failed = failedWords(deploy?.failed);
  return {
    short: words.short(n),
    tick: words.tick(n, failed),
    ok: words.ok,
    kicker: words.kicker,
    fact: words.fact,
    evidence: words.evidence(n, failed),
  };
}

/**
 * A merged fix held for its deploy, as its row on the line and its picture caption it: what became of the merge, and
 * what it waits for now, from the release that carried it and the deploy pull request (`DEPLOY_WORDS`).
 */
export function deployCaption(
  ended: Ended | undefined,
  deploy: DeployRecord | undefined,
  waitsForMartin: boolean,
): [done: string, waiting: string] {
  const done = ended ? backWords(ended.stopped) : 'merged';
  if (ended?.stopped) return [done, stopWait(ended.stopped)];
  if (!waitsForMartin) return [done, deployWords(deploy).short];
  return [done, ended ? 'waiting for Martin’s retry or next deploy' : 'waiting for Martin’s deploy'];
}

/**
 * The release that carried the last merge and ended without shipping, while the fix waits for the next deploy or
 * Martin's retry: when, its version, and what stopped it, if it was stopped rather than rolled back.
 */
export function endedSinceMerge(item: ItemState): Ended | undefined {
  const merged = ofType(item, 'pull-request.merged').at(-1)?.ts ?? '';
  const ended = item.events.findLast((e): e is ReleaseStop => stopsRelease(e) && e.ts >= merged);
  if (!ended) return undefined;
  if (ended.type === 'release.rolled-back')
    return { at: Date.parse(ended.ts), version: ended.payload.version, stopped: undefined };
  const stopped = ended.type === 'release.aborted' ? ended.payload.by : 'error';
  return { at: Date.parse(ended.payload.abortedAt), version: ended.payload.version, stopped };
}

/** The pull request Martin is asked to merge, with its whole change: every round together, as a merge brings it in. */
function mergePicture(item: ItemState): Picture | undefined {
  const final = coderPushes(item).at(-1)?.payload;
  if (!final) return undefined;
  const last = attempts(item).at(-1);
  const scope = ofType(item, 'spec.written').at(-1)?.payload.scope;
  const review = last?.review;
  return {
    type: 'merge',
    pullRequest: final.number,
    title: final.title,
    checks: { passed: last?.gates?.passed ?? 0, total: last?.gates?.total ?? 0 },
    testsFirst: last?.gates?.testsFirst,
    review: review && { suggestions: review.suggestions, number: review.number },
    files: final.whole.length,
    added: final.whole.reduce((n, f) => n + f.added, 0),
    removed: final.whole.reduce((n, f) => n + f.removed, 0),
    inScope: Boolean(scope && final.whole.every((file) => knownInScope(file, scope))),
  };
}

/** The scope fence's last refusal, in its own words, and the one before it since Martin last answered. */
function scopePicture(item: ItemState): Picture | undefined {
  const refused = refusals(item);
  const refusal = refused.at(-1);
  if (!refusal) return undefined;
  const earlier = refused.at(-2);
  return {
    type: 'scope',
    patch: refusal.patch,
    refusals: refused.length,
    output: refusal.output,
    earlier: earlier && {
      patch: earlier.patch,
      same: refusal.refused.length > 0 && earlier.refused.join() === refusal.refused.join(),
    },
    reachedGitHub: coderPushes(item).length > 0,
  };
}

/** The tests-first check's own output, where it failed on the last attempt: the change's tests pass on the base. */
function testsPassPicture(item: ItemState): Picture | undefined {
  const tests = attempts(item)
    .at(-1)
    ?.gates?.runs.find((run) => !run.required && isTestsFirst(run.check));
  if (tests?.conclusion !== 'failure') return undefined;
  return { type: 'tests-pass', output: tests.output ?? tests.summary ?? '' };
}

/** What the work item spent, by agent, against the cap the hold records. */
function spendPicture(item: ItemState, hold: Hold): Picture | undefined {
  if (hold.limitUsd === undefined) return undefined;
  const steps = ofType(item, 'model.called');
  const agents = new Map<string, { agent: string; cost: number; steps: number }>();
  for (const { payload } of steps) {
    const row = agents.get(payload.agent) ?? { agent: payload.agent, cost: 0, steps: 0 };
    row.cost += payload.costUsd;
    row.steps += 1;
    agents.set(payload.agent, row);
  }
  const stopped = steps.at(-1)?.payload.agent;
  return {
    type: 'spend',
    stage: hold.stage,
    spent: item.spend,
    cap: hold.limitUsd,
    agents: [...agents.values()],
    // The step the cap stopped: the last one that called a model.
    stopped: stopped ? { agent: stopped, step: agents.get(stopped)?.steps ?? 1 } : undefined,
  };
}

/**
 * Whether an event starts the work's next pass, as the line counts them: a return to Plan, from Verify or by Martin
 * after the merge, and a reopening each start again with a new spec, pull request and reviews.
 */
export const startsPass = (event: PublicEvent) =>
  (event.type === 'work.returned' && event.payload.to === 'plan') || event.type === 'work-item.reopened';

/**
 * The last review's findings still blocking, each with the reviews of its pass that blocked the same thing: the line
 * bounds each pass's reviews alone. Each review keeps its number in the whole thread.
 */
function blockingPicture(item: ItemState): Picture | undefined {
  const start = item.events.findLastIndex(startsPass);
  let number = 0;
  const pass = item.events.flatMap((event, i) => {
    if (event.type !== 'review.submitted') return [];
    number += 1;
    return i > start ? [{ number, payload: event.payload }] : [];
  });
  const latest = pass.at(-1)?.payload;
  // An escalation holds at Review too, with no findings to show, and its reason says why; unless it went beyond the
  // ticket, which its blocking findings show.
  const shows = latest?.verdict === 'changes-requested' || latest?.findings.some((f) => f.ticket);
  const open = shows ? (latest?.findings.filter((f) => f.blocking) ?? []) : [];
  if (!open.length) return undefined;
  return {
    type: 'blocking',
    reviews: pass.length,
    findings: open.map((f) => ({
      where: `${f.path}:${f.line}`,
      cites: f.ticket
        ? 'the ticket'
        : f.rule !== undefined
          ? `rule ${f.rule}${RULES[f.rule] ? `, ${RULES[f.rule]?.title.toLowerCase()}` : ''}`
          : f.criterion !== undefined
            ? `criterion ${f.criterion}`
            : undefined,
      comment: f.comment,
      reviews: pass.flatMap((r) =>
        r.payload.findings.some(
          (g) => g.blocking && g.path === f.path && g.rule === f.rule && g.criterion === f.criterion,
        )
          ? [r.number]
          : [],
      ),
    })),
  };
}
