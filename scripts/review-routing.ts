/**
 * Approval routing (spec 4.3, ADR 0014): what the review gate decides a pull request's verdict by, from facts it read
 * through GitHub's API (`review-gate.ts` reads them). Pure functions, so each rule and each exception has a test.
 *
 * The risk tags come from the diff alone, never from labels:
 *
 * - `dependency-change`: a lockfile or package manifest, anywhere;
 * - `security-headers`: the app's header settings, `src/headers.ts`, or a line added or removed anywhere in the app's
 *   code that names a security header, so a header set outside that file is caught too;
 * - `test-loosening`: each test that test integrity excused as one the pull request's spec contradicts, read from its
 *   check run's annotations, which name the test and its file;
 * - `code-owned`: a path CODEOWNERS on `main` gives Martin;
 * - `release`: release-please's branch, or a change to its files alone;
 * - `improvement`: the app's typed list of flag names changed, or a line of the app's code, added or removed, that
 *   names a flag or asks one, so new behaviour behind a flag already on the list is caught too.
 *
 * The rule, the first that holds: `martin-opened`, `martin-approved-head`, `exact-pin`, `low-risk`, `lights-out`, or
 * `held` (`route`).
 */
import {
  type Verdict as Block,
  FLAG_NAMES_FILE,
  type Found,
  found,
  HEADERS_FILE,
  NEVER_LIGHTS_OUT,
  passes,
  RISK_LABELS,
  type Rule,
  TAGS,
  type Tag,
} from '../policy/review-verdict.ts';

/** Martin's GitHub account, by its id, which never changes: a login can be renamed and taken by someone else. */
export const MARTIN = 6206459;

/** The review App, which alone posts the `review` check the rulesets require. */
export const REVIEW_APP = 5470762;

/** The factory's App's bot user (`mrogan-software-factory[bot]`), which opens its pull requests. */
export const FACTORY_APP = 337765427;

/** The app's repository: the only one where Lights-out applies, and the App's pull requests may pass untagged. */
export const APP_REPO = 'the-roganator/cv-worlds-worst-website';

/** Test integrity's check run, as the app's `gates.yml` calls `app-gates.yml`'s job, posted by GitHub Actions. */
export const TEST_INTEGRITY_CHECK = 'gates / test integrity';
export const ACTIONS_SLUG = 'github-actions';

export interface PullRequest {
  number: number;
  state: string;
  user: { id: number } | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
  /** How many files it changes, which the files API lists up to 3,000 of. */
  changed_files?: number;
}

export interface Review {
  user: { id: number } | null;
  state: string;
  commit_id: string | null;
}

/** A file of a pull request, as the files API gives it. */
export interface FileChange {
  filename: string;
  status: string;
  previous_filename?: string;
  /** The unified diff's hunks; GitHub leaves it out of a binary file, one too large, or a rename with no change. */
  patch?: string | undefined;
  /** How many lines it adds and removes: 0 for a file renamed unchanged. */
  changes?: number;
}

export interface Verdict {
  pass: boolean;
  /** One line, the check's title. */
  title: string;
}

/** A verdict, with the rule that decided it and the tags it found. */
export interface Decision extends Verdict {
  rule: Rule;
  tags: Found[];
  /**
   * Set only on a hold that waits for a read: what the gate could not read yet, with nothing it did read holding the
   * pull request. Judged again once it can be read, the verdict may differ. Whole here: the summary's block cuts it
   * (`cutPending`).
   */
  pending?: string;
  /**
   * Set only on a hold for an exact pin the gate could not check (`Facts.pin`'s `unchecked`), with nothing it did read
   * holding the pull request: the cause, which `pending` says too.
   */
  unchecked?: string;
  /** Set beside `unchecked` when its base has been changed: an earlier verdict at its head judged other pins. */
  retargeted?: true;
}

const short = (sha: string) => sha.slice(0, 7);

/** Whether a pull request comes from a branch of the repository it is into, not a fork's. */
const fromHere = (pr: PullRequest) => pr.head.repo?.full_name === pr.base.repo.full_name;

/** Whether the factory's App opened a pull request, from a branch here. */
export const appOpened = (pr: PullRequest) => pr.user?.id === FACTORY_APP && fromHere(pr);

/**
 * Whether Martin has had his say on a pull request at its head. A review that only comments says nothing; of the rest,
 * his latest counts: an approval, changes asked, or an approval dismissed. `reviews` is in the order GitHub gives them,
 * oldest first.
 */
export function verdict(pr: PullRequest, reviews: readonly Review[]): Verdict & { rule?: Rule } {
  // From a branch in this repository: one Martin opens from someone else's fork would carry their pushes.
  if (pr.user?.id === MARTIN && fromHere(pr)) {
    return { pass: true, title: 'Martin opened it', rule: 'martin-opened' };
  }
  const latest = reviews
    .filter((r) => r.user?.id === MARTIN && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .at(-1);
  const head = short(pr.head.sha);
  if (!latest) return { pass: false, title: `Waits for Martin to approve ${head}` };
  if (latest.state === 'CHANGES_REQUESTED') return { pass: false, title: 'Martin asked for changes' };
  if (latest.state === 'DISMISSED')
    return { pass: false, title: `His last review was dismissed: waits for him to approve ${head}` };
  if (latest.commit_id !== pr.head.sha) {
    const approved = latest.commit_id
      ? `Martin approved ${short(latest.commit_id)}`
      : 'Martin approved an earlier commit';
    return { pass: false, title: `${approved}, and it has moved since: waits for him to approve ${head}` };
  }
  return { pass: true, title: `Martin approved ${head}`, rule: 'martin-approved-head' };
}

// CODEOWNERS

/** One line of CODEOWNERS: its pattern, as a test of a path, and whether it gives the path to Martin. */
export interface OwnerRule {
  pattern: string;
  matches: (path: string) => boolean;
  martins: boolean;
}

/** Martin's handle in CODEOWNERS. */
export const MARTIN_LOGIN = 'mrogan';

/** A CODEOWNERS pattern as a regular expression, as GitHub reads one: gitignore's rules, without `!` or `[]`. */
export function ownerPattern(pattern: string): RegExp {
  const directory = pattern.endsWith('/');
  let body = directory ? pattern.slice(0, -1) : pattern;
  // A slash at the start or in the middle anchors the pattern at the root; otherwise it matches at any depth.
  const anchored = body.startsWith('/') || body.includes('/');
  body = body.replace(/^\//, '');
  let source = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === '*' && body[i + 1] === '*') {
      if (body[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}${directory ? '/.*' : '(?:/.*)?'}$`);
}

/** CODEOWNERS' rules, in order: the last one that matches a path says who owns it, and one with no owner, nobody. */
export function codeOwners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    const test = ownerPattern(pattern);
    rules.push({
      pattern,
      matches: (path) => test.test(path),
      martins: owners.some((o) => o.toLowerCase() === `@${MARTIN_LOGIN}`),
    });
  }
  return rules;
}

/** The rule that gives a path to Martin, if the last rule matching it does. */
export function martinsRule(rules: readonly OwnerRule[], path: string): OwnerRule | undefined {
  const last = rules.findLast((rule) => rule.matches(path));
  return last?.martins ? last : undefined;
}

// Test integrity

/** A check run, as the checks API lists them for a commit. */
export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app: { slug: string } | null;
  started_at?: string | null;
  output?: { annotations_count?: number };
  /**
   * The open pull requests whose head is the run's commit on the branch it ran for, as GitHub lists them now: a run on
   * a pull request's event names it here, and one another pull request's event started at the same commit, from
   * another branch, does not.
   */
  pull_requests?: readonly { number: number }[];
}

export interface Annotation {
  path: string;
  annotation_level: string;
  message: string;
}

/**
 * Test integrity's run for a pull request's head, or why there is none to trust. Only GitHub Actions' run counts: the
 * factory's App can post check runs too. Only a run that names the judged pull request among its `pull_requests`
 * counts, since test integrity reads the description of the pull request whose event started it: a second pull
 * request at the same head, from another branch, has a run of its own, reading its own description's excuses, which
 * never stands for this one's. A run that also names another pull request, on the same branch into another base, may
 * have read either's description, so it is no reading. It fails closed: a missing, pending, skipped, cancelled or failed run, or one
 * only another app posted, is no reading. GitHub Actions runs it from the workflow on the pull request's own branch, so
 * a pull request that changes anything under `.github/` is not read from it (and is code-owned, and held, anyway).
 * Only GitHub Actions' latest attempt for the head counts, the one with the highest id (a re-run queued has no
 * `started_at` yet, but its id is the newest): an older attempt left queued or unclosed neither keeps it waiting nor
 * gives the reading once a newer one has completed. `pending` marks a reading that may yet come: no run of GitHub
 * Actions' for the head naming the pull request, or its latest not yet completed. Runs another app posted, and
 * another pull request's, are ignored for that, and never read: one of that name posted by the factory's App cannot
 * turn a wait for the real run into a hold. Every other reason is a reading that will not come.
 */
export function testIntegrityRun(
  runs: readonly CheckRun[],
  head: string,
  files: readonly FileChange[],
  base: string,
  number: number,
): { run: CheckRun } | { reason: string; pending?: true } {
  const named = runs.filter((run) => run.name === TEST_INTEGRITY_CHECK && run.head_sha === head);
  const actions = named.filter((run) => run.app?.slug === ACTIONS_SLUG);
  const ours = actions.filter((run) => run.pull_requests?.some((p) => p.number === number)).sort((a, b) => b.id - a.id);
  const workflow = files.find((f) => [f.filename, f.previous_filename].some((p) => p?.startsWith('.github/')));
  if (workflow)
    return { reason: `it changes ${workflow.filename}, so test integrity's run is not the workflow on main's` };
  // Into another branch, its run is that branch's workflow, which a pull request below could have changed unseen here.
  if (base !== 'main') return { reason: `it is into ${base}, so test integrity's run is not the workflow on main's` };
  const latest = ours[0];
  if (latest && latest.status !== 'completed')
    return { reason: `test integrity is still running at ${short(head)}`, pending: true };
  if (!latest) {
    const foreign = named[0]?.app?.slug ?? 'an unknown app';
    return {
      reason: actions.length
        ? `test integrity has not run for #${number} at ${short(head)}: GitHub Actions' runs there do not name it`
        : named.length
          ? `test integrity has not run at ${short(head)}: only ${foreign} posted a run of that name, not GitHub Actions`
          : `test integrity has not run at ${short(head)}`,
      pending: true,
    };
  }
  // Two open pull requests from one branch, into different bases: each one's run names both.
  const others = latest.pull_requests?.filter((p) => p.number !== number) ?? [];
  if (others.length)
    return {
      reason: `test integrity's run at ${short(head)} also names ${others.map((p) => `#${p.number}`).join(', ')}, so whose description it read is not known`,
    };
  if (latest.conclusion !== 'success')
    return { reason: `test integrity's run at ${short(head)} is ${latest.conclusion ?? 'unfinished'}, not a success` };
  return { run: latest };
}

/**
 * Test integrity's words for a test it excused, as `test-integrity.ts` annotates each: `"<test>" was deleted` or
 * `rewritten`, `as the spec it was changed for contradicts it`. A test holds the two the same.
 */
export const EXCUSED = /^"(.*)" was (deleted|rewritten), as the spec it was changed for contradicts it$/s;

/**
 * The tests test integrity excused, from its run's annotations: each warning on a file names one. A warning on a file
 * the gate cannot read is counted too, saying so, so a change in test integrity's words holds a pull request rather
 * than passing it. GitHub's own annotations of the job are on `.github`.
 */
export function excusedTests(annotations: readonly Annotation[]): string[] {
  const tests: string[] = [];
  for (const a of annotations) {
    if (a.annotation_level !== 'warning' || a.path === '.github' || a.path.startsWith('.github/')) continue;
    const named = EXCUSED.exec(a.message);
    tests.push(named ? `${a.path}: ${named[1]} (${named[2]})` : `${a.path}: a warning the gate cannot read`);
  }
  return tests;
}

// Risk tags

/**
 * The files that are a lockfile or a package manifest, by name, anywhere, and those that say where packages come from
 * and what runs as they install: `.npmrc` (the registry, scripts allowed) and `.pnpmfile.cjs` (install hooks).
 */
const DEPENDENCY_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  '.npmrc',
  '.pnpmfile.cjs',
]);

/**
 * The security headers, and the app's name for its settings of them: a line of the app's code (not its tests) added or
 * removed that names one, in any case, is a change to the security headers, wherever it is. The one list.
 */
export const SECURITY_HEADER_NAMES = [
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
  'Strict-Transport-Security',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Resource-Policy',
  'SECURITY_HEADERS',
] as const;
/** Text as a regular expression that matches it literally: every character a pattern gives a meaning escaped. */
export const literally = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const NAMES_A_HEADER = new RegExp(SECURITY_HEADER_NAMES.map(literally).join('|'), 'i');

/** The lines a patch adds or removes, without their sign. */
export const changedLines = (patch: string) =>
  patch
    .split('\n')
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .map((line) => line.slice(1));

/** The branches release-please opens its pull requests from. */
const RELEASE_BRANCH = /^release-please--/;

/** The files a release changes, and no others. */
const RELEASE_FILES = new Set(['CHANGELOG.md', 'package.json', '.release-please-manifest.json']);

/**
 * A line of the app's code, added or removed, that names a flag or asks one: the flag context's `flag`, by any route
 * (called, destructured, passed on), or a set of flags' `.on(`. A removed one counts too, since taking a flag's ask
 * away gives what it guarded to everyone. Broad on purpose: a line it catches that asks no flag holds a pull request
 * for Martin, and one it missed would pass new behaviour unattended.
 */
export const ASKS_A_FLAG = /\bflag\b|\.on\s*\(/;

/** The app's shipped code, which is where a flag is asked: not its tests. */
const APP_CODE = /^src\/.+\.ts$/;
const TEST_CODE = /(^|\/)(test|tests|__tests__)\/|\.test\.ts$|\.spec\.ts$/;

const pathsOf = (file: FileChange) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])];
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export interface TagFacts {
  files: readonly FileChange[];
  /** Whether the files API listed every file: past 3,000 it does not. */
  complete: boolean;
  headRef: string;
  owners: readonly OwnerRule[];
  /** The tests test integrity excused, when its run could be read. */
  excused: readonly string[];
}

/** The risk tags a diff carries, each with what gave it, in `TAGS`' order. */
export function tagsOf({ files, complete, headRef, owners, excused }: TagFacts): Found[] {
  const given = new Map<Tag, string[]>();
  const add = (tag: Tag, what: string) => given.set(tag, [...(given.get(tag) ?? []), what]);
  if (excused.length) for (const test of excused) add('test-loosening', test);
  for (const each of files) {
    // A file renamed unchanged has no patch, and no line to read: its names are read as any file's.
    const file =
      each.patch === undefined && each.status === 'renamed' && each.changes === 0 ? { ...each, patch: '' } : each;
    for (const path of pathsOf(file)) {
      if (DEPENDENCY_FILES.has(baseName(path))) add('dependency-change', path);
      if (path === HEADERS_FILE) add('security-headers', path);
      const rule = martinsRule(owners, path);
      if (rule) add('code-owned', `${path} (${rule.pattern})`);
      if (path === FLAG_NAMES_FILE) add('improvement', path);
    }
    // Either name: a rename out of the app's code carries the lines it removed there.
    const paths = pathsOf(file);
    if (!paths.includes(HEADERS_FILE) && paths.some((p) => p.startsWith('src/') && !TEST_CODE.test(p))) {
      if (file.patch === undefined)
        add('security-headers', `${file.filename}: GitHub gives no patch to read for a header`);
      else {
        const line = changedLines(file.patch).find((each) => NAMES_A_HEADER.test(each));
        if (line !== undefined) add('security-headers', `${file.filename}: ${line.trim().slice(0, 120)}`);
      }
    }
    if (!paths.includes(FLAG_NAMES_FILE) && paths.some((p) => APP_CODE.test(p) && !TEST_CODE.test(p))) {
      // Removed too: a file too large for a patch could take a flag's ask away unread.
      if (file.patch === undefined) {
        add('improvement', `${file.filename}: GitHub gives no patch to read for a flag`);
      } else {
        const line = changedLines(file.patch).find((each) => ASKS_A_FLAG.test(each));
        if (line !== undefined) add('improvement', `${file.filename}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  if (RELEASE_BRANCH.test(headRef)) add('release', `release-please's branch, ${headRef}`);
  else if (files.length > 0 && files.every((f) => pathsOf(f).every((p) => RELEASE_FILES.has(p))))
    add('release', `only a release's files: ${files.map((f) => f.filename).join(', ')}`);
  if (!complete) add('code-owned', 'more files than GitHub lists: the rest are unread');
  return TAGS.filter((tag) => given.has(tag)).map((tag) => found(tag, given.get(tag) ?? []));
}

// Labels

/** An issue event, as the issue events API gives a pull request's. */
export interface IssueEvent {
  event: string;
  actor: { id: number } | null;
  label?: { name: string };
}

/** The risk labels anyone but Martin removed from a pull request, each once. */
export function riskLabelsRemoved(events: readonly IssueEvent[]): string[] {
  const removed = events
    .filter((e) => e.event === 'unlabeled' && e.actor?.id !== MARTIN && RISK_LABELS.includes(e.label?.name ?? ''))
    .map((e) => e.label?.name ?? '');
  return [...new Set(removed)];
}

// Exact pins

/** A pin a pull request moves: in which file, the image, and the digest it replaces and the one it sets. */
export interface Pin {
  file: string;
  image: string;
  from: string;
  to: string;
}

const DIGEST_LINE = /^(\s*(?:-\s+)?)digest:\s*(sha256:[0-9a-f]{64})\s*$/;

/**
 * Each digest a file's patch moves, line by line, or why the patch is not an exact pin: every line it removes or adds
 * is a `digest:` value, and each removed one is replaced, in its place, by one added with the same indent.
 */
export function digestMoves(file: FileChange): { from: string; to: string }[] | { reason: string } {
  if (!file.filename.startsWith('deploy/') || !/\.ya?ml$/.test(file.filename))
    return { reason: `${file.filename} is not a pin file under deploy/` };
  if (file.status !== 'modified') return { reason: `${file.filename} is ${file.status}, not modified` };
  if (file.patch === undefined) return { reason: `GitHub gives no patch of ${file.filename} to read` };
  const moves: { from: string; to: string }[] = [];
  let removed: { indent: string; digest: string }[] = [];
  let added: { indent: string; digest: string }[] = [];
  const close = (): string | undefined => {
    if (removed.length !== added.length) return `${file.filename} adds or removes a pin rather than moving one`;
    for (const [i, was] of removed.entries()) {
      const now = added[i];
      if (!now || now.indent !== was.indent) return `${file.filename} moves a digest to another line`;
      moves.push({ from: was.digest, to: now.digest });
    }
    removed = [];
    added = [];
    return undefined;
  };
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('-') || line.startsWith('+')) {
      const digest = DIGEST_LINE.exec(line.slice(1));
      if (!digest) return { reason: `${file.filename} changes a line that is not a digest: ${line.slice(0, 120)}` };
      (line.startsWith('-') ? removed : added).push({ indent: digest[1] ?? '', digest: digest[2] ?? '' });
    } else {
      // A line both sides share, a hunk's header, or "\ No newline at end of file": the moves so far are paired.
      const wrong = close();
      if (wrong) return { reason: wrong };
    }
  }
  const wrong = close();
  if (wrong) return { reason: wrong };
  if (moves.length === 0) return { reason: `${file.filename} moves no digest` };
  return moves;
}

/**
 * The image a pin in a kustomization names: the `newName` of the `images:` entry whose `digest:` is `digest`, in the
 * file as the pull request's head has it.
 */
export function imageOf(content: string, digest: string): string | undefined {
  const lines = content.split('\n');
  const at = lines.findIndex((line) => DIGEST_LINE.exec(line)?.[2] === digest);
  // A digest two entries share names no one image: the pin could be checked against the other's.
  if (at === -1 || lines.findLastIndex((line) => DIGEST_LINE.exec(line)?.[2] === digest) !== at) return undefined;
  // The entry runs from its `- ` line to the next at that indent, or a line indented less.
  let start = at;
  while (start > 0 && !/^\s*-\s/.test(lines[start] as string)) start--;
  const indent = (lines[start] as string).search(/-/);
  const entry = [lines[start] as string];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const lead = line.search(/\S/);
    if (lead < indent || (lead === indent && /^\s*-\s/.test(line))) break;
    entry.push(line);
  }
  const names = entry.map((line) => /^\s*(?:-\s+)?newName:\s*(\S+)\s*$/.exec(line)?.[1]).filter(Boolean);
  return names.length === 1 ? names[0] : undefined;
}

/** The repository whose `build.yml` signs an image, from its name in GHCR: only the factory's and the app's. */
export function signerOf(image: string): string | undefined {
  const repo = /^ghcr\.io\/the-roganator\/([\w.-]+)(?:\/[\w.-]+)?$/.exec(image)?.[1];
  return repo === 'cv-software-factory' || repo === 'cv-worlds-worst-website' ? `the-roganator/${repo}` : undefined;
}

export interface PinChecks {
  /** The commit `build.yml` on main signed the image at, verified, or why it is not signed so. */
  signedAt: (repo: string, image: string, digest: string) => Promise<string | { reason: string }>;
  /** Whether `to` descends from `from` in `repo`: the compare API's `ahead`. */
  ahead: (repo: string, from: string, to: string) => Promise<boolean>;
  /** A file as the pull request's head has it. */
  content: (path: string) => Promise<string>;
}

/**
 * Whether a pull request is an exact pin: every changed line a `digest:` value, each to an image `build.yml` signed on
 * main from a commit that descends from the one the pin it replaces was built from. A reason when it is not, marked
 * `digests` when every line it changes is a digest under `deploy/`, so it is a pin, but not an exact one. A check that
 * could not be made (GitHub, GHCR or Sigstore not answering) throws, as `checks` do: that is no judgement of the pin.
 */
export async function exactPin(
  files: readonly FileChange[],
  checks: PinChecks,
  complete: boolean,
): Promise<{ pins: Pin[] } | { reason: string; digests?: true }> {
  if (files.length === 0) return { reason: 'it changes no file' };
  if (!complete) return { reason: 'GitHub lists only some of its files, and the rest are unread' };
  // Every file a change of digests alone first, so a reason for one file's pin is never given to a change that is no
  // pin at all, and nothing is read for one.
  const moved: { file: FileChange; moves: { from: string; to: string }[] }[] = [];
  for (const file of files) {
    const moves = digestMoves(file);
    if (!Array.isArray(moves)) return moves;
    moved.push({ file, moves });
  }
  const pins: Pin[] = [];
  for (const { file, moves } of moved) {
    const content = await checks.content(file.filename);
    for (const { from, to } of moves) {
      const image = imageOf(content, to);
      if (!image) return { reason: `${file.filename} names no one image for ${short(to.slice(7))}`, digests: true };
      pins.push({ file: file.filename, image, from, to });
    }
  }
  for (const pin of pins) {
    if (!signerOf(pin.image))
      return { reason: `${pin.image} is not an image the factory's or the app's build.yml signs`, digests: true };
  }
  // Each pin is checked at once, as cosign takes a while for each, and the first to fail in order says why.
  const checked = await Promise.all(
    pins.map(async (pin): Promise<string | undefined> => {
      const repo = signerOf(pin.image) as string;
      const [to, from] = await Promise.all([
        checks.signedAt(repo, pin.image, pin.to),
        checks.signedAt(repo, pin.image, pin.from),
      ]);
      if (typeof to !== 'string') return `${pin.image}@${short(pin.to.slice(7))}: ${to.reason}`;
      if (typeof from !== 'string') return `${pin.image}@${short(pin.from.slice(7))}: ${from.reason}`;
      if (!(await checks.ahead(repo, from, to)))
        return `${pin.image}'s ${short(to)} does not descend from ${short(from)}, the commit it replaces`;
      return undefined;
    }),
  );
  const reason = checked.find((each) => each !== undefined);
  if (reason) return { reason, digests: true };
  return { pins };
}

// The rule

export interface Facts {
  /** The repository the pull request is in, `owner/name`. */
  repo: string;
  pr: PullRequest;
  reviews: readonly Review[];
  /** The caller's `AUTONOMY` variable, as the workflow read it. */
  autonomy: string;
  tags: Found[];
  /** Test integrity's reading of the head, or why there is none; `pending` when it may yet be read. */
  testIntegrity: { read: true } | { read: false; reason: string; pending?: true };
  /** The risk labels someone other than Martin removed. */
  labelsRemoved: readonly string[];
  /** What the gate could not read from GitHub, which holds the pull request unless Martin has had his say. */
  unread?: string;
  /** Whether its base has been changed since it opened: its pins are then not the same at the same head. */
  retargeted?: boolean;
  /**
   * The exact pin check's result, for a pull request of the App's: its pins, why it is not an exact pin (`digests` when
   * it changes digests alone), or why the check could not be made, after the gate tried again.
   */
  pin?: { pins: Pin[] } | { reason: string; digests?: true } | { unchecked: string };
}

const tagNames = (tags: readonly Found[]) => tags.map((t) => t.tag).join(', ');

/**
 * Whether the level passes these tags of an App's pull request in the app's repository: none at all at any level, and
 * at Lights-out any but those it never passes. The one test, for the lights-out rule and for whether a hold for want
 * of test integrity's reading is only a wait.
 */
export const levelPasses = (tags: readonly Found[], autonomy: string): boolean =>
  tags.length === 0 || (autonomy === 'lights-out' && !tags.some((t) => NEVER_LIGHTS_OUT.includes(t.tag)));
/** Martin's verdict after another clause: a name keeps its capital. */
const lower = (text: string) => text.replace(/^Waits/, 'waits');

/** The verdict on one pull request at its head: the first rule that holds, or held, with why. */
export function route(facts: Facts): Decision {
  const { repo, pr, reviews, tags } = facts;
  const martin = verdict(pr, reviews);
  if (martin.pass && martin.rule) return { pass: true, title: martin.title, rule: martin.rule, tags };
  const held = (why: string): Decision => ({
    pass: false,
    title: `${why}: ${lower(martin.title)}`,
    rule: 'held',
    tags,
  });
  // A read that failed is a hold, never a wait: nothing runs the gate again for it, and it may never succeed.
  if (facts.unread) return held(`The gate could not read the pull request whole (${facts.unread})`);
  if (!appOpened(pr)) return { pass: false, title: martin.title, rule: 'held', tags };
  if (facts.labelsRemoved.length)
    return held(`Someone other than Martin removed its ${facts.labelsRemoved.join(', ')} label`);
  const { pin } = facts;
  if (pin && 'pins' in pin) {
    const images = [...new Set(pin.pins.map((p) => p.image.slice(p.image.lastIndexOf('/') + 1)))];
    return { pass: true, title: `An exact pin of ${images.join(', ')}, each signed on main`, rule: 'exact-pin', tags };
  }
  // A check that could not be made is no judgement, of the pin or of its risk: a wait for the gate to judge it again,
  // in either repository, which never passes it and never falls through to its tags.
  if (pin && 'unchecked' in pin) {
    const cause = `the gate could not check its exact pin: ${pin.unchecked}`;
    return {
      ...held(`Not judged yet: ${cause}`),
      pending: cause,
      unchecked: pin.unchecked,
      ...(facts.retargeted ? { retargeted: true as const } : {}),
    };
  }
  if (repo !== APP_REPO) {
    const why = pin && 'reason' in pin ? `: ${pin.reason}` : '';
    return held(`Not an exact pin${why}, and here only a pin passes without Martin`);
  }
  // A change of digests alone passes only as an exact pin, in the app's repository too, and its hold says why not.
  if (pin && 'reason' in pin && pin.digests)
    return held(`Not an exact pin: ${pin.reason}, and a change of digests alone passes only as one`);
  const passed = levelPasses(tags, facts.autonomy);
  // Tags the level does not pass hold it whatever test integrity says, so they decide first, and it is no wait.
  // Its title names test integrity's reading too when there is none, so Martin does not approve on the tags alone.
  if (!passed) {
    const integrity = facts.testIntegrity.read
      ? ''
      : facts.testIntegrity.pending
        ? `; test integrity has not read it yet (${facts.testIntegrity.reason})`
        : `; no reading of test integrity (${facts.testIntegrity.reason})`;
    return held(`Held for its risk tags (${tagNames(tags)})${integrity}`);
  }
  if (!facts.testIntegrity.read) {
    const { reason, pending } = facts.testIntegrity;
    if (pending) return { ...held(`Waits for test integrity before it judges: ${reason}`), pending: reason };
    return held(`No reading of test integrity: ${reason}`);
  }
  if (tags.length === 0)
    return {
      pass: true,
      title: "Low-risk: the factory's App opened it, and it has no risk tags",
      rule: 'low-risk',
      tags,
    };
  return { pass: true, title: `Lights-out passes its risk tags: ${tagNames(tags)}`, rule: 'lights-out', tags };
}

/**
 * Whether the review App's latest verdict on a commit, which passed, stands when this run could only fail it for exact
 * pins it could not check: so a check that could not be made does not overturn one that was. It stands only when
 * every pull request held now is held for that alone, the verdict judged the same pull requests at the same heads, on
 * this commit, each by a rule that passes, and each held now by `exact-pin`, whose pins at a head do not change while
 * its base does not: one whose base has ever been changed is judged afresh. Every other fact was read afresh by this
 * run and passes. `earlier` is the block of that check, read by `readVerdict`.
 */
export function stands(
  earlier: Block,
  commit: string,
  now: readonly { number: number; head: string; said: Decision }[],
): boolean {
  if (earlier.commit !== commit || earlier.judged.length !== now.length) return false;
  if (!now.some(({ said }) => !said.pass)) return false;
  if (now.some(({ said }) => !said.pass && (said.unchecked === undefined || said.retargeted))) return false;
  return now.every(({ number, head, said }) => {
    const was = earlier.judged.find((entry) => entry.number === number);
    if (!was || was.head !== head || !passes(was.rule) || was.pending !== undefined) return false;
    return said.pass || was.rule === 'exact-pin';
  });
}

/**
 * What gave a tag, as plain text in the summary's Markdown: a path or a line of the pull request's can carry no code
 * span, table or HTML, so it can neither break the words nor open a second verdict's comment, which would make the
 * summary carry none.
 */
const plain = (text: string) =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[`|]/g, "'")
    .replace(/</g, '&lt;');

/** The words Needs you shows beside the verdict's block: the rule, and a line for each tag with what gave it. */
export function words(number: number, decision: Decision): string {
  const lines = [`**#${number}**: ${plain(decision.title)} (\`${decision.rule}\`).`];
  if (decision.tags.length === 0) lines.push('', 'No risk tags.');
  else {
    lines.push('', 'Risk tags:', '');
    for (const tag of decision.tags) {
      const given = tag.because.map(plain).join('; ');
      const more = tag.more ? (given ? `, and ${tag.more} more` : `${tag.more} things`) : '';
      lines.push(`- \`${tag.tag}\`: ${given}${more}`);
    }
  }
  return lines.join('\n');
}
