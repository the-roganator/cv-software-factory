/**
 * The review gate (ADR 0014): whether a pull request has Martin's say, posted as the `review` check by the review App.
 * It passes when Martin opened the pull request from a branch here, or when his latest verdict on it approves the commit
 * at its head. Nothing in the rule depends on the base, so a pull request into any branch is judged, a stacked one's
 * into the branch below it too.
 *
 *     node scripts/review-gate.ts      # in review.yml, which GitHub runs from main's copy only
 *
 * It reads the event GitHub hands the workflow, and the pull request and its reviews through the API, and never the
 * pull request's code. It runs on `workflow_run`, after `review-requested.yml` ran, which runs as the pull request or
 * the queue's commit has it and so holds nothing:
 *
 * - for a pull request opened, pushed to, reopened, made ready or edited, and for a review of one: the check goes on the
 *   pull request's head as it is now, judged on every open pull request here whose head that commit is, since a check
 *   on a commit is each one's. It passes only when each passes, and otherwise names those that do not, so every run
 *   that judges a commit, whichever pull request asked, says the same of it from the same reviews;
 * - for the merge queue: the check goes on the merge group's commit, judged on the pull request it was made for, which
 *   the queue names in its branch. A queued stack has an entry for each of its pull requests, each with a branch of
 *   that ordinary name and built on the entry below it, so an upper one's commit carries the changes below it too: one
 *   into another branch is judged with every pull request below it, down to the one into main, and passes only when
 *   each does. A branch the gate does not know, or a stack it cannot follow down to main, fails the check there,
 *   saying why.
 *
 * A pull request it finds open always gets a verdict, passing or failing, so a missing check never hides why a pull
 * request waits. The verdict is in the check's title and the run's log; the gate writes no file.
 *
 * Anyone who can push a branch can make a run of a workflow named "review requested", so a `workflow_run` says only
 * which pull request to look at again. The verdict is always read afresh from GitHub, so a forged request reruns the
 * honest gate.
 *
 *     GH_TOKEN         the workflow's token, to read the pull request and its reviews
 *     CHECKS_TOKEN     the review App's installation token, to post the check. Without it, the verdict is said and not
 *                      posted: the App is not set up yet
 *     GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL   as Actions sets them
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { cutPending, type Found, type Judged, verdictBlock } from '../policy/review-verdict.ts';
import {
  type Annotation,
  appOpened,
  type CheckRun,
  codeOwners,
  type Decision,
  exactPin,
  excusedTests,
  type Facts,
  type FileChange,
  type IssueEvent,
  MARTIN,
  type OwnerRule,
  type PullRequest,
  type Review,
  riskLabelsRemoved,
  route,
  TEST_INTEGRITY_CHECK,
  tagsOf,
  testIntegrityRun,
  type Verdict,
  verdict,
  words,
} from './review-routing.ts';

export { MARTIN, type PullRequest, type Review, type Verdict, verdict } from './review-routing.ts';

/** The check the ruleset requires, from the review App's integration only. */
export const CHECK = 'review';

/**
 * The branch the merge queue makes for a pull request: `gh-readonly-queue/<base>/pr-<number>-<base commit>`, the number
 * its second group. pr-title.yml matches the same in bash, so it is written as a POSIX extended expression too, and a
 * test holds the two the same.
 */
export const QUEUE_BRANCH = /^(refs\/heads\/)?gh-readonly-queue\/main\/pr-([0-9]+)-[0-9a-f]{7,40}$/;

const short = (sha: string) => sha.slice(0, 7);

/** What a run is asked to look at: a pull request, and the commit its check goes on (its head, unless the queue's). */
export type Target =
  | { kind: 'pull-request'; number: number; commit?: undefined }
  | { kind: 'queue'; number: number; commit: string }
  | { kind: 'find'; owner: string; branch: string; commit: string }
  /** Nothing to judge. With a commit, the check there fails giving the reason: the queue's, on a branch it cannot read. */
  | { kind: 'none'; reason: string; commit?: string };

interface Event {
  workflow_run?: {
    event: string;
    head_branch: string | null;
    head_sha: string;
    head_repository?: { owner: { login: string } } | null;
    pull_requests?: { number: number; base: { ref: string; repo?: { url: string } } }[];
  };
}

/**
 * The open pull requests in `repo` whose head is `commit`, from those GitHub lists for the commit, which include merged
 * ones that contain it, and from `known`, one already found there, in case the list lags behind. For a commit already
 * on the default branch, GitHub lists only the pull request that merged it, so `known` is the only open one found.
 */
export function atHead(
  listed: readonly PullRequest[],
  commit: string,
  repo: string,
  known?: PullRequest,
): PullRequest[] {
  const all = new Map<number, PullRequest>();
  for (const pr of [...listed, ...(known ? [known] : [])]) {
    if (pr.state === 'open' && pr.head.sha === commit && pr.base.repo.full_name === repo) all.set(pr.number, pr);
  }
  return [...all.values()].sort((a, b) => a.number - b.number);
}

/** Pull requests by number, the first few: a check's title is one line, however many share a head. */
const names = (prs: readonly { number: number }[]) =>
  prs.length > 5
    ? `${prs
        .slice(0, 5)
        .map((p) => `#${p.number}`)
        .join(', ')} and ${prs.length - 5} more`
    : prs.map((p) => `#${p.number}`).join(', ');

/**
 * The verdict on a commit that is the head of several open pull requests. A check is on a commit, so it is every one's:
 * it passes only when each passes, and otherwise names those that do not, so every run that judges the commit, from any
 * of them, says the same.
 */
export function together(judged: readonly { number: number; said: Verdict }[]): Verdict {
  if (judged.length === 1 && judged[0]) return judged[0].said;
  const held = judged.filter((j) => !j.said.pass);
  if (held.length === 0) return { pass: true, title: `Each of ${names(judged)} passes` };
  if (held.length === 1 && held[0]) return { pass: false, title: `#${held[0].number}: ${held[0].said.title}` };
  return { pass: false, title: `${names(held)} do not pass: each waits for Martin` };
}

/** The deepest stack the gate follows down from a queued pull request: one deeper fails, as a loop does. */
export const STACK_LIMIT = 10;

/** A queued pull request and those below it, down to the one into main, or why the gate cannot follow them. */
export type Stack = { prs: PullRequest[]; reason?: undefined } | { reason: string; prs?: undefined };

/**
 * The stack a queued pull request heads, from the one into main up to `top`, following each base down to the open pull
 * request here whose head it is. `below(branch)` lists the open pull requests from this repository's branch of that
 * name. It fails unless each step finds exactly one, so a branch two pull requests come from, into different bases,
 * names no stack; and when the pull request below has merged and the one above has not yet been retargeted to main, it
 * finds none, and fails until the queue tries again.
 */
export async function stackOf(
  top: PullRequest,
  repo: string,
  below: (branch: string) => Promise<PullRequest[]>,
): Promise<Stack> {
  const prs = [top];
  for (let at = top; at.base.ref !== 'main'; ) {
    if (prs.length >= STACK_LIMIT)
      return {
        reason: `the stack #${top.number} heads is longer than ${STACK_LIMIT} pull requests, which the gate follows`,
      };
    const base = at.base.ref;
    const found = (await below(base)).filter(
      (pr) =>
        pr.state === 'open' &&
        pr.head.ref === base &&
        pr.head.repo?.full_name === repo &&
        pr.base.repo.full_name === repo,
    );
    const [next, ...more] = found;
    if (!next) return { reason: `#${at.number} is into ${base}, which no open pull request here comes from` };
    if (more.length > 0)
      return { reason: `#${at.number} is into ${base}, which ${names(found)} all come from: no one stack below it` };
    if (prs.some((pr) => pr.number === next.number))
      return { reason: `the stack below #${top.number} comes back to #${next.number}` };
    prs.unshift(next);
    at = next;
  }
  return { prs };
}

/**
 * The pull request a run is about, from the event GitHub handed the workflow, for the repository `repo` (`owner/name`).
 */
export function target(name: string, event: Event, repo: string): Target {
  const run = event.workflow_run;
  if (name !== 'workflow_run' || !run) return { kind: 'none', reason: `nothing to do on ${name}` };
  if (run.event === 'merge_group') {
    const number = QUEUE_BRANCH.exec(run.head_branch ?? '')?.[2];
    // A queued stack's entries have branches of this name too: one the gate cannot read fails the queue's commit, naming
    // the branch.
    if (!number)
      return {
        kind: 'none',
        reason: `the merge queue's branch ${run.head_branch} is not gh-readonly-queue/main/pr-<number>-<commit>, which the gate reads`,
        commit: run.head_sha,
      };
    return { kind: 'queue', number: Number(number), commit: run.head_sha };
  }
  if (run.event === 'pull_request' || run.event === 'pull_request_review') {
    // A pull request whose head is the commit to judge, whichever: every open one with that head is judged with it.
    // GitHub names one only when its branch is in this repository and still at the run's commit; a fork's, or a branch
    // that has moved since, is found by its branch. Only this repository's: a run from a fork's branch can name the
    // fork's own pull requests too.
    const number = run.pull_requests?.find((p) => p.base.repo?.url.endsWith(`/repos/${repo}`))?.number;
    if (number) return { kind: 'pull-request', number };
    const owner = run.head_repository?.owner.login;
    if (!owner || !run.head_branch) return { kind: 'none', reason: `the ${run.event} names no pull request` };
    return { kind: 'find', owner, branch: run.head_branch, commit: run.head_sha };
  }
  return { kind: 'none', reason: `a review is not asked for by ${run.event}` };
}

/** What one run of the gate reads with, and where its verdicts go. */
export interface Run {
  /** The repository whose pull requests it judges, `owner/name`. */
  repo: string;
  /** The workflow's token, to read. */
  read: string;
  /** The review App's token, to post the check; empty, nothing is posted. */
  token: string;
  /** The caller's `AUTONOMY` variable. */
  autonomy: string;
  /** Print each verdict and its summary, and post nothing, whatever the token: for trying the gate by hand. */
  print: boolean;
}

const apiUrl = () => process.env.GITHUB_API_URL ?? 'https://api.github.com';

async function request(method: string, path: string, token: string, accept: string, body?: unknown) {
  return fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function api<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const response = await request(method, path, token, 'application/vnd.github+json', body);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** A file's text at a commit, through the contents API, or undefined if it is not there. */
async function fileAt(repo: string, path: string, ref: string, token: string): Promise<string | undefined> {
  const where = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  const response = await request('GET', where, token, 'application/vnd.github.raw+json');
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${where}: ${response.status} ${await response.text()}`);
  return response.text();
}

/** Every item of a list GitHub gives a page at a time, from the answer itself or the key it is under. */
async function paged<T>(path: string, token: string, key?: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const answer = await api<unknown>(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      token,
    );
    const batch = (key ? (answer as Record<string, T[]>)[key] : answer) as T[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** Every open pull request in `repo` from `owner`'s branch `branch`, into any base: all of them, so none is missed. */
const openFrom = (repo: string, owner: string, branch: string, token: string) =>
  paged<PullRequest>(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, token);

/** CODEOWNERS as `main` has it, where GitHub looks for it, never as a pull request has it. */
const ownersOnMain = new Map<string, Promise<OwnerRule[]>>();
function owners(run: Run): Promise<OwnerRule[]> {
  let read = ownersOnMain.get(run.repo);
  if (!read) {
    read = (async () => {
      for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        const text = await fileAt(run.repo, path, 'main', run.read);
        if (text !== undefined) return codeOwners(text);
      }
      throw new Error(`${run.repo} has no CODEOWNERS on main: the gate cannot tell which paths are Martin's`);
    })();
    ownersOnMain.set(run.repo, read);
  }
  return read;
}

// An exact pin's checks, which read GHCR anonymously, cosign and the compare API.

const GHCR = 'https://ghcr.io';
const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The commit an image says it was built from: its one `org.opencontainers.image.revision` label, on every platform. */
async function revisionOf(image: string, digest: string): Promise<string | { reason: string }> {
  const name = image.replace(/^ghcr\.io\//, '');
  const auth = await fetch(`${GHCR}/token?scope=repository:${name}:pull`, { signal: AbortSignal.timeout(15_000) });
  if (!auth.ok) return { reason: `ghcr.io gave no token to read it: ${auth.status}` };
  const { token } = (await auth.json()) as { token?: string };
  const get = async <T>(path: string, accept: string): Promise<T> => {
    const response = await fetch(`${GHCR}/v2/${name}/${path}`, {
      headers: { accept, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`ghcr.io answered ${response.status} for ${path}`);
    return (await response.json()) as T;
  };
  type Manifest = { config?: { digest: string }; manifests?: { digest: string; platform?: { os?: string } }[] };
  const index = await get<Manifest>(`manifests/${digest}`, MANIFESTS);
  const configs = index.config
    ? [index.config.digest]
    : await Promise.all(
        (index.manifests ?? [])
          .filter((m) => m.platform?.os && m.platform.os !== 'unknown')
          .map(async (m) => (await get<Manifest>(`manifests/${m.digest}`, MANIFESTS)).config?.digest ?? ''),
      );
  const revisions = new Set<string>();
  for (const config of new Set(configs)) {
    const labels = (await get<{ config?: { Labels?: Record<string, string> | null } }>(`blobs/${config}`, '*/*')).config
      ?.Labels;
    revisions.add(labels?.['org.opencontainers.image.revision'] ?? '');
  }
  const [revision, ...others] = [...revisions];
  if (!revision || others.length || !/^[0-9a-f]{40}$/.test(revision))
    return { reason: 'it names no one commit it was built from' };
  return revision;
}

const run = promisify(execFile);

/**
 * The commit `build.yml` on main signed an image at, verified by cosign: keyless, the certificate Fulcio gave that
 * workflow, on main, at the commit the image names, logged in Rekor. The commit the image names is only a claim until
 * the certificate says the same.
 */
const signatures = new Map<string, Promise<string | { reason: string }>>();
function signedAt(repo: string, image: string, digest: string): Promise<string | { reason: string }> {
  const key = `${image}@${digest}`;
  let checked = signatures.get(key);
  if (!checked) {
    checked = (async () => {
      try {
        const revision = await revisionOf(image, digest);
        if (typeof revision !== 'string') return revision;
        await run(
          'cosign',
          [
            'verify',
            '--certificate-identity',
            `https://github.com/${repo}/.github/workflows/build.yml@refs/heads/main`,
            '--certificate-oidc-issuer',
            'https://token.actions.githubusercontent.com',
            '--certificate-github-workflow-repository',
            repo,
            '--certificate-github-workflow-ref',
            'refs/heads/main',
            '--certificate-github-workflow-sha',
            revision,
            `${image}@${digest}`,
          ],
          { timeout: 120_000 },
        );
        return revision;
      } catch (error) {
        const said = error instanceof Error ? error.message.split('\n').find((l) => /error/i.test(l)) : undefined;
        return { reason: `cosign does not verify it as signed by build.yml on main${said ? ` (${said.trim()})` : ''}` };
      }
    })();
    signatures.set(key, checked);
  }
  return checked;
}

/** Whether `to` descends from `from`, by the compare API. */
async function ahead(repo: string, from: string, to: string, token: string): Promise<boolean> {
  const { status } = await api<{ status: string }>('GET', `/repos/${repo}/compare/${from}...${to}`, token);
  return status === 'ahead';
}

/** Every fact a pull request is judged on, read through the API, and its verdict. */
export async function judge(each: Run, pr: PullRequest, withoutMartin = false): Promise<Decision> {
  const { repo, read } = each;
  const head = pr.head.sha;
  const judged = withoutMartin && pr.user?.id === MARTIN ? { ...pr, user: null } : pr;
  // His reviews are read inside the guard too: unread, they count as no say, and the pull request is held saying why,
  // rather than the run failing and leaving no verdict at all.
  let reviews: Review[] = [];
  const facts = () => ({ repo, pr: judged, reviews, autonomy: each.autonomy });
  try {
    if (!withoutMartin) reviews = await paged<Review>(`/repos/${repo}/pulls/${pr.number}/reviews`, read);
    const [files, events, runs, rules] = await Promise.all([
      paged<FileChange>(`/repos/${repo}/pulls/${pr.number}/files`, read),
      paged<IssueEvent>(`/repos/${repo}/issues/${pr.number}/events`, read),
      paged<CheckRun>(
        `/repos/${repo}/commits/${head}/check-runs?filter=all&check_name=${encodeURIComponent(TEST_INTEGRITY_CHECK)}`,
        read,
        'check_runs',
      ),
      owners(each),
    ]);
    const integrity = testIntegrityRun(runs, head, files, pr.base.ref);
    let testIntegrity: Facts['testIntegrity'] = { read: true };
    let excused: string[] = [];
    if ('run' in integrity) {
      const annotations = await paged<Annotation>(`/repos/${repo}/check-runs/${integrity.run.id}/annotations`, read);
      const expected = integrity.run.output?.annotations_count ?? 0;
      // Fewer is a page lost, more a set that is not the run's: either way, the excused tests are not known. The run
      // has completed, so no new reading is coming: a hold, not a wait.
      if (annotations.length !== expected)
        testIntegrity = { read: false, reason: `GitHub gave ${annotations.length} of its ${expected} annotations` };
      excused = excusedTests(annotations);
    } else testIntegrity = { read: false, ...integrity };
    const complete = files.length >= (pr.changed_files ?? 0);
    const tags = tagsOf({
      files,
      complete,
      headRef: pr.head.ref,
      owners: rules,
      excused,
    });
    // Martin's say passes it before an exact pin is looked at, so cosign is not asked.
    const pin =
      appOpened(judged) && !verdict(judged, reviews).pass
        ? await exactPin(
            files,
            {
              signedAt,
              ahead: (where, from, to) => ahead(where, from, to, read),
              content: async (path) => {
                const text = await fileAt(repo, path, head, read);
                if (text === undefined) throw new Error(`${path} is not at ${short(head)}`);
                return text;
              },
            },
            complete,
          ).catch((error: Error) => ({ reason: `the gate could not check it: ${error.message}` }))
        : undefined;
    return route({
      ...facts(),
      tags,
      testIntegrity,
      labelsRemoved: riskLabelsRemoved(events),
      ...(pin ? { pin } : {}),
    });
  } catch (error) {
    // Martin's say needs only his reviews, if they were read; anything else unread holds the pull request, saying what.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::warning::${message}`);
    return route({
      ...facts(),
      tags: [],
      testIntegrity: { read: false, reason: 'not read' },
      labelsRemoved: [],
      unread: message.split('\n')[0]?.slice(0, 200) ?? message,
    });
  }
}

const RULE =
  "Passes a pull request Martin opened, or whose head he approved; an exact pin of the factory's App's, of images " +
  "build.yml signed on main; and in the app's repository the App's with no risk tags, or at Lights-out those whose " +
  'tags it allows (spec 4.3, ADR 0014).';

/** The most a check run's summary may hold, GitHub's 65,535 characters, with room to spare. */
export const SUMMARY_LIMIT = 60_000;

/** A tag with no more than `keep` of what gave it, the rest counted. */
const cut = (tag: Found, keep: number): Found => {
  const more = (tag.more ?? 0) + Math.max(0, tag.because.length - keep);
  return more > 0 ? { tag: tag.tag, because: tag.because.slice(0, keep), more } : tag;
};

/**
 * The check's summary: the rule, each pull request's words, and the verdict's block, which the line reads. A queued
 * stack with many tags could pass GitHub's limit, and a summary over it is refused, leaving no verdict at all: so what
 * gave each tag is cut, fewer each time, until it fits. The rule, the tags and the heads are never cut.
 */
export function summaryOf(commit: string, judged: readonly { pr: PullRequest; said: Decision }[]): string {
  let summary = '';
  for (const keep of [Number.POSITIVE_INFINITY, 5, 1, 0]) {
    const fitted = judged.map(({ pr, said }) => ({ pr, said: { ...said, tags: said.tags.map((t) => cut(t, keep)) } }));
    const entries: Judged[] = fitted.map(({ pr, said }) => ({
      number: pr.number,
      head: pr.head.sha,
      rule: said.rule,
      tags: said.tags,
      ...(said.pending ? { pending: cutPending(said.pending) } : {}),
    }));
    summary = [
      RULE,
      ...fitted.map(({ pr, said }) => words(pr.number, said)),
      verdictBlock({ version: 1, commit, judged: entries }),
    ].join('\n\n');
    if (summary.length <= SUMMARY_LIMIT) break;
  }
  return summary;
}

/** Posts the `review` check on a commit, as the review App, or says why it does not. */
async function post(each: Run, commit: string, pass: boolean, title: string, summary: string) {
  if (each.print) {
    console.log(`Would post ${CHECK}: ${pass ? 'success' : 'failure'} on ${commit}: ${title}\n\n${summary}\n`);
    return;
  }
  if (!each.token) {
    console.log(`::notice::The review App is not set up yet (ADR 0014): the ${CHECK} check is not posted.`);
    return;
  }
  await api('POST', `/repos/${each.repo}/check-runs`, each.token, {
    name: CHECK,
    head_sha: commit,
    status: 'completed',
    conclusion: pass ? 'success' : 'failure',
    output: { title, summary },
  });
  console.log(`Posted ${CHECK}: ${pass ? 'success' : 'failure'} on ${commit}.`);
}

/** Each pull request judged at its own head, each said in the run's log. */
async function judgeEach(each: Run, prs: readonly PullRequest[]) {
  const judged = [];
  for (const pr of prs) {
    const said = await judge(each, pr);
    const tags = said.tags.length ? ` [${said.tags.map((t) => t.tag).join(', ')}]` : '';
    console.log(
      `#${pr.number}, into ${pr.base.ref}, at ${short(pr.head.sha)}: ${said.rule}${tags}: ${said.pass ? `passes: ${said.title}` : said.title}.`,
    );
    judged.push({ pr, number: pr.number, said });
  }
  return judged;
}

/** Every pull request open in `repo` that contains `commit`, merged ones too, as GitHub lists them. */
const containing = (repo: string, commit: string, token: string) =>
  paged<PullRequest>(`/repos/${repo}/commits/${commit}/pulls`, token);

/**
 * Judges the head of `pr` as it is now, on every open pull request whose head it is: a check is on a commit, so each
 * of them carries it, and whichever asked, the verdict is the same.
 */
async function judgeHead(each: Run, pr: PullRequest): Promise<void> {
  const { repo, read } = each;
  const commit = pr.head.sha;
  let listed: PullRequest[];
  try {
    listed = await containing(repo, commit, read);
  } catch (error) {
    // Without the list, a verdict could pass a commit another open pull request holds: fail it, saying why.
    console.log(`::warning::${error instanceof Error ? error.message : String(error)}`);
    const title = `The gate could not list the pull requests at ${short(commit)}: re-run it`;
    if (pr.state === 'open') await post(each, commit, false, title, `No verdict without the list. ${RULE}`);
    return;
  }
  const open = atHead(listed, commit, repo, pr);
  // A closed pull request merges nothing, and no open one has its head: nothing to hold.
  if (open.length === 0) {
    console.log(`#${pr.number} is ${pr.state}, and no open pull request has ${short(commit)}: nothing to judge.`);
    return;
  }
  // Each read whole from GitHub: the list names a pull request as it was, and lacks how many files it changes.
  const full = await Promise.all(
    open.map((one) => api<PullRequest>('GET', `/repos/${repo}/pulls/${one.number}`, read)),
  );
  const judged = await judgeEach(
    each,
    full.filter((one) => one.state === 'open' && one.head.sha === commit),
  );
  if (judged.length === 0) {
    console.log(`No open pull request is at ${short(commit)} now: nothing to judge.`);
    return;
  }
  const said = together(judged);
  const numbers = judged.map((one) => `#${one.number}`).join(', ');
  console.log(`${short(commit)}, the head of ${numbers}: ${said.pass ? `passes: ${said.title}` : said.title}.`);
  await post(each, commit, said.pass, said.title, summaryOf(commit, judged));
}

/** What a run is asked, from the environment Actions sets, or, by hand, `--print <owner/name> <number>`. */
function asked(args: readonly string[]): { each: Run; event?: Event; name: string; number?: number } {
  const { GH_TOKEN: read = '', CHECKS_TOKEN: token = '', AUTONOMY: autonomy = '' } = process.env;
  if (args[0] === '--print') {
    const [, repo = '', number = ''] = args;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number)) {
      throw new Error('usage: review-gate.ts --print <owner/name> <number>');
    }
    return { each: { repo, read, token: '', autonomy, print: true }, name: 'print', number: Number(number) };
  }
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf-8')) as Event;
  return { each: { repo, read, token, autonomy, print: false }, event, name: process.env.GITHUB_EVENT_NAME ?? '' };
}

async function main(): Promise<void> {
  const { each, event, name, number } = asked(process.argv.slice(2));
  const { repo, read } = each;
  console.log(`AUTONOMY is ${each.autonomy ? JSON.stringify(each.autonomy) : 'unset'} for ${repo}.`);
  if (number !== undefined) {
    // By hand, a pull request is judged alone at its head, merged or closed too, to compare with what main's gate said.
    const pr = await api<PullRequest>('GET', `/repos/${repo}/pulls/${number}`, read);
    const judged = await judgeEach(each, [pr]);
    const said = together(judged);
    await post(each, pr.head.sha, said.pass, said.title, summaryOf(pr.head.sha, judged));
    // And what the rest of the rules say, as if Martin had had no say.
    const rest = await judge(each, pr, true);
    console.log(`Without Martin's say: ${rest.rule}: ${rest.title}.`);
    return;
  }
  let target_ = target(name, event ?? {}, repo);
  if (target_.kind === 'find') {
    // The open pull request from that branch, wherever its head is now: the run that asked may be for an older push,
    // and the verdict goes on the head as it is now.
    const { owner, branch } = target_;
    const found = (await openFrom(repo, owner, branch, read))[0];
    target_ = found
      ? { kind: 'pull-request', number: found.number }
      : { kind: 'none', reason: `no open pull request has ${owner}:${branch}` };
  }
  if (target_.kind === 'none') {
    console.log(`Nothing to judge: ${target_.reason}.`);
    if (target_.commit) {
      const title = target_.reason.charAt(0).toUpperCase() + target_.reason.slice(1);
      await post(each, target_.commit, false, title, `No pull request to judge. ${RULE}`);
    }
    return;
  }
  let pr: PullRequest;
  try {
    pr = await api<PullRequest>('GET', `/repos/${repo}/pulls/${target_.number}`, read);
  } catch (error) {
    // The queue's commit always gets a verdict: without the pull request, it fails, saying to re-run.
    if (target_.kind !== 'queue') throw error;
    console.log(`::warning::${error instanceof Error ? error.message : String(error)}`);
    const title = `The gate could not read #${target_.number}, which the merge queue's branch names: re-run it`;
    await post(each, target_.commit, false, title, `No verdict without the pull request. ${RULE}`);
    return;
  }
  if (target_.kind === 'pull-request') {
    await judgeHead(each, pr);
    return;
  }
  // A closed pull request merges nothing: the queue holds none.
  if (pr.state !== 'open') {
    console.log(`#${pr.number} is ${pr.state}: nothing to judge.`);
    return;
  }
  const commit = target_.commit;
  // The queue's commit merges into main, and carries every change below the pull request it was made for: a stacked
  // one's approval vouches for its own change alone, so each pull request below it down to main is judged too, each
  // afresh at its head as it is now, never by a verdict judged for another commit.
  // A pull request it finds open always gets a verdict: if GitHub cannot be read, the check fails, saying to re-run it.
  let stack: Stack;
  let judged: Awaited<ReturnType<typeof judgeEach>> = [];
  try {
    stack = await stackOf(pr, repo, (branch) => openFrom(repo, repo.split('/')[0] ?? '', branch, read));
    if (stack.prs) {
      const full = await Promise.all(
        stack.prs.map((one) =>
          one.number === pr.number ? pr : api<PullRequest>('GET', `/repos/${repo}/pulls/${one.number}`, read),
        ),
      );
      judged = await judgeEach(each, full);
    }
  } catch (error) {
    console.log(`::warning::${error instanceof Error ? error.message : String(error)}`);
    stack = { reason: `the gate could not read the stack #${pr.number} heads, or judge it: re-run it` };
  }
  if (stack.reason !== undefined) {
    const title = stack.reason.charAt(0).toUpperCase() + stack.reason.slice(1);
    console.log(`Nothing to judge on the merge queue's ${short(commit)}: ${title}.`);
    await post(each, commit, false, title, `The merge queue's commit is judged on a stack down to main. ${RULE}`);
    return;
  }
  const said = together(judged);
  console.log(
    `The merge queue's ${short(commit)}, for #${pr.number}: ${said.pass ? `passes: ${said.title}` : said.title}.`,
  );
  await post(each, commit, said.pass, said.title, summaryOf(commit, judged));
}

if (import.meta.main) await main();
