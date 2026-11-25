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
 * The rule, the first that holds: `martin-opened`, `martin-approved-head`, `exact-pin` (the App's, of images signed on
 * main, `exactPin`; or Dependabot's, of the commit the factory's workflows are called at, `workflowPin`), `move` or
 * `major` (exactly the moves the scan of main asked for, made by the gate and compared with the pull request, whoever
 * opened it, scripts/move.ts), in the app's repository `low-risk` and `lights-out`, or `held` (`route`).
 */

import { APP_REPOSITORY, FACTORY_REPOSITORY, repositoryOfImage } from '../apps/factory/src/repositories.ts';
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

/**
 * GitHub's Dependabot (`dependabot[bot]`), by its user id, as Martin and the App are known: it alone opens its pull
 * requests, and one that moves only the commit the factory's workflows are called at passes as an exact pin
 * (`workflowPin`).
 */
export const DEPENDABOT = 49699333;

/** This repository, the factory's: where the App's pull requests pass only as pins or moves (ADR 0022). */
export const FACTORY_REPO = FACTORY_REPOSITORY;

/** The app's repository: the only one where Lights-out applies, and the App's pull requests may pass untagged. */
export const APP_REPO = APP_REPOSITORY;

/** Test integrity's check run, as the app's `gates.yml` calls `app-gates.yml`'s job, posted by GitHub Actions. */
export const TEST_INTEGRITY_CHECK = 'gates / test integrity';
export const ACTIONS_SLUG = 'github-actions';

export interface PullRequest {
  number: number;
  state: string;
  user: { id: number } | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string }; sha?: string };
  /** When it was opened: a run of its head made before then was made for another. */
  created_at?: string;
  /** How many files it changes, which the files API lists up to 3,000 of. */
  changed_files?: number;
}

/** The events that change a pull request's base: anyone's, and GitHub's own when the base branch goes. */
export const RETARGETED: ReadonlySet<string> = new Set(['base_ref_changed', 'automatic_base_change_succeeded']);

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
export const fromHere = (pr: PullRequest) => pr.head.repo?.full_name === pr.base.repo.full_name;

/** Whether the factory's App opened a pull request, from a branch here. */
export const appOpened = (pr: PullRequest) => pr.user?.id === FACTORY_APP && fromHere(pr);

/** Whether GitHub's Dependabot opened a pull request, from a branch here. */
export const dependabotOpened = (pr: PullRequest) => pr.user?.id === DEPENDABOT && fromHere(pr);

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
}

export interface Annotation {
  path: string;
  annotation_level: string;
  message: string;
}

/**
 * Test integrity's run for a pull request's head, or why there is none to trust. Only GitHub Actions' run counts: the
 * factory's App can post check runs too. It fails closed: a missing, pending, skipped, cancelled or failed run, or one
 * only another app posted, is no reading. GitHub Actions runs it from the workflow on the pull request's own branch, so
 * a pull request that changes anything under `.github/` is not read from it (and is code-owned, and held, anyway).
 * Only GitHub Actions' latest attempt for the head counts, the one with the highest id (a re-run queued has no
 * `started_at` yet, but its id is the newest): an older attempt left queued or unclosed neither keeps it waiting nor
 * gives the reading once a newer one has completed. `pending` marks a reading that may yet come: no run of GitHub
 * Actions' for the head, or its latest not yet completed. Runs another app posted are ignored for that, and never
 * read: one of that name posted by the factory's App cannot turn a wait for the real run into a hold. Every other
 * reason is a reading that will not come.
 */
export function testIntegrityRun(
  runs: readonly CheckRun[],
  head: string,
  files: readonly FileChange[],
  base: string,
): { run: CheckRun } | { reason: string; pending?: true } {
  const named = runs.filter((run) => run.name === TEST_INTEGRITY_CHECK && run.head_sha === head);
  const ours = named.filter((run) => run.app?.slug === ACTIONS_SLUG).sort((a, b) => b.id - a.id);
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
      reason: named.length
        ? `test integrity has not run at ${short(head)}: only ${foreign} posted a run of that name, not GitHub Actions`
        : `test integrity has not run at ${short(head)}`,
      pending: true,
    };
  }
  if (latest.conclusion !== 'success')
    return { reason: `test integrity's run at ${short(head)} is ${latest.conclusion ?? 'unfinished'}, not a success` };
  return { run: latest };
}

/**
 * Test integrity's notice of the pull request a run judged, and its base, as `test-integrity.ts` writes it
 * (`judgedNote`). The run reads that pull request's description, so its excuses are that pull request's alone.
 */
export const JUDGED = /^Test integrity judged #([1-9]\d*) into (.+)$/s;

/**
 * Why test integrity's run is not the judged pull request's reading, by the notice it wrote of what it judged, or
 * nothing when it is: its notice, and only its, names the pull request, into the base it has now. Another pull
 * request's run at the same head, from another branch or another base, closed since or not, read that one's
 * description, and is never this one's; nor is a run that judged it into another base, before it was retargeted. The
 * latest run at the head being another's is a wait, as its own may yet be run again; a run that names no pull request,
 * or judged this one into another base, is a hold.
 */
export function notJudged(
  annotations: readonly Annotation[],
  number: number,
  base: string,
  head: string,
): { reason: string; pending?: true } | undefined {
  const judged = annotations
    .filter((a) => a.annotation_level === 'notice')
    .map((a) => JUDGED.exec(a.message))
    .filter((m) => m !== null)
    .map((m) => ({ number: Number(m[1]), base: m[2] as string }));
  const at = `test integrity's run at ${short(head)}`;
  if (!judged.length) return { reason: `${at} does not say which pull request it judged` };
  const other = judged.find((j) => j.number !== number);
  if (other) return { reason: `${at} judged #${other.number}, not #${number}`, pending: true };
  const into = judged.find((j) => j.base !== base);
  if (into) return { reason: `${at} judged #${number} into ${into.base}, not ${base}` };
  return undefined;
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
export const signerOf = repositoryOfImage;

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

// Exact pins of the factory's workflows

/** Where the factory's workflows are, as a caller's `uses:` names them. */
const FACTORY_WORKFLOWS = `${FACTORY_REPO}/.github/workflows/`;

/**
 * A call of one of the factory's workflows at a commit of its main, as a caller writes the whole line: the key, the
 * workflow, the commit in full, and the comment that says which branch the commit is on. Its first group is all that
 * comes before the commit, its second the workflow's file, and its third the commit.
 */
const WORKFLOW_CALL = new RegExp(
  String.raw`^(\s+uses: ${literally(FACTORY_WORKFLOWS)}([\w-]+\.yml))@([0-9a-f]{40}) # main$`,
);

/** Whether a line names the factory's workflows at all, however it is written: GitHub reads a repository in any case. */
export const callsFactory = (line: string): boolean => line.toLowerCase().includes(FACTORY_WORKFLOWS.toLowerCase());

/** A call of the factory's workflows a pull request moves: in which file, and the commit it replaces and the one it sets. */
export interface CallMove {
  file: string;
  /** The factory's workflow it calls, by its file's name. */
  workflow: string;
  from: string;
  to: string;
}

/**
 * Each call of the factory's workflows a file's patch moves, or why the patch is not an exact pin: the file is a
 * workflow, modified, and every line it removes or adds is one call of the factory's workflows at a commit, each
 * removed one replaced, in its place, by one that reads the same but for the commit.
 */
export function callMoves(file: FileChange): CallMove[] | { reason: string } {
  const { filename } = file;
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(filename) || file.previous_filename !== undefined)
    return { reason: `${filename} is not a workflow under .github/workflows/` };
  if (file.status !== 'modified') return { reason: `${filename} is ${file.status}, not modified` };
  if (file.patch === undefined) return { reason: `GitHub gives no patch of ${filename} to read` };
  const moves: CallMove[] = [];
  let removed: { before: string; workflow: string; commit: string }[] = [];
  let added: { before: string; workflow: string; commit: string }[] = [];
  const close = (): string | undefined => {
    if (removed.length !== added.length) return `${filename} adds or removes a call rather than moving its commit`;
    for (const [i, was] of removed.entries()) {
      const now = added[i];
      if (!now || now.before !== was.before) return `${filename} changes more of a call than its commit`;
      moves.push({ file: filename, workflow: was.workflow, from: was.commit, to: now.commit });
    }
    removed = [];
    added = [];
    return undefined;
  };
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('-') || line.startsWith('+')) {
      const call = WORKFLOW_CALL.exec(line.slice(1));
      if (!call)
        return {
          reason: `${filename} changes a line that is not a call of the factory's workflows at a commit of main: ${line.slice(0, 120)}`,
        };
      (line.startsWith('-') ? removed : added).push({
        before: call[1] ?? '',
        workflow: call[2] ?? '',
        commit: call[3] ?? '',
      });
    } else {
      // A line both sides share, a hunk's header, or "\ No newline at end of file": the moves so far are paired.
      const wrong = close();
      if (wrong) return { reason: wrong };
    }
  }
  const wrong = close();
  if (wrong) return { reason: wrong };
  if (moves.length === 0) return { reason: `${filename} moves no call` };
  return moves;
}

// What a called workflow declares

/** A line of YAML that says something: not blank, and not a comment alone. */
const says = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');
const indentOf = (line: string) => line.search(/\S/);

/** What the gate does not read of a declaration, which holds a bump whose declaration's text differs. */
class Unread extends Error {}

/** A scalar on one line, as YAML's core schema reads it: quoted, or plain, less a comment after it. */
function scalarOf(text: string): unknown {
  const single = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
  if (single) return (single[1] ?? '').replace(/''/g, "'");
  const double = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(text);
  if (double) {
    try {
      return JSON.parse(`"${double[1] ?? ''}"`) as string;
    } catch {
      throw new Unread(`a quoted value it does not read: ${text.slice(0, 60)}`);
    }
  }
  const plain = text.replace(/\s+#.*$/, '');
  // A list, a map in braces, an anchor, a tag, or a key of its own: none is in what a workflow_call declares.
  if (/^['"[\]{}&*!|>%@`,]|^[-?] |: |:$/.test(plain))
    throw new Unread(`a value it does not read: ${plain.slice(0, 60)}`);
  if (/^(true|True|TRUE)$/.test(plain)) return true;
  if (/^(false|False|FALSE)$/.test(plain)) return false;
  if (/^(null|Null|NULL|~)$/.test(plain)) return null;
  // A number is read only as it is written whole: `20.10` and `20.1`, `010` and `10`, `1e2` and `100` are one number
  // each and other texts, and a caller is given the text. Any other way of writing one is not read.
  if (NUMBER.test(plain)) {
    if (String(Number(plain)) !== plain) throw new Unread(`a number it does not read as it is written: ${plain}`);
    return Number(plain);
  }
  return plain;
}

/** What YAML reads as a number when it is written plain: decimal, with an exponent, hexadecimal, octal, infinite or none. */
const NUMBER =
  /^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$|^0x[0-9a-fA-F]+$|^0o[0-7]+$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/;

/**
 * Whether a line of a declaration holds an anchor, an alias or a merge key (`&name`, `*name`, `<<:`), as a key, a
 * value or an item: what such a declaration says is written somewhere outside its own lines.
 */
const refersElsewhere = (line: string): boolean => {
  if (!says(line)) return false;
  const item = line.trim().replace(/^(?:-\s+)+/, '');
  const value = /^(?:[\w.-]+|'[^']*'|"[^"\\]*")\s*:\s+(.*)$/.exec(item)?.[1] ?? '';
  // In brackets or braces, one may be any item or value of it.
  const within = /^[[{]/.test(value) && /(^|[\s[{,:])(?:[&*][\w-]|<<\s*:)/.test(value);
  return /^[&*]\S/.test(item) || /^[&*]\S/.test(value) || /^<<\s*:/.test(item) || within;
};

/**
 * A block of YAML that is maps of maps of scalars, read: each key on a line of its own, its value on that line, a map
 * indented under it, or a block scalar (`|`, `>`), which is kept as its lines are. That is all a `workflow_call`
 * declaration holds, and anything else (a list, braces, an anchor, a value over several lines) throws `Unread`: the
 * gate runs with Node alone, no YAML library beside it, so it reads this much and holds what it cannot.
 */
function mapOf(lines: readonly string[]): Record<string, unknown> | null {
  const first = lines.find(says);
  if (first === undefined) return null;
  const indent = indentOf(first);
  // With no prototype: a name a file gives (`__proto__`, `constructor`, `toString`) is a key as any other.
  const map: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? '';
    if (!says(line)) {
      i++;
      continue;
    }
    const entry = /^\s*([\w.-]+|'[^']*'|"[^"\\]*")\s*:(?:\s+(.*))?$/.exec(line);
    if (indentOf(line) !== indent || !entry) throw new Unread(`a line that is no key: ${line.trim().slice(0, 60)}`);
    const key = (entry[1] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    if (Object.hasOwn(map, key)) throw new Unread(`${key} twice`);
    let end = i + 1;
    while (end < lines.length && (!says(lines[end] ?? '') || indentOf(lines[end] ?? '') > indent)) end++;
    const under = lines.slice(i + 1, end);
    const value = (entry[2] ?? '').replace(/^#.*$/, '').trim();
    const header = value.replace(/\s+#.*$/, '');
    if (/^[|>](?:[+-]\d?|\d[+-]?)?$/.test(header)) {
      // As its lines are, less the indent and what follows it: a block scalar written another way is another value.
      const stop = under.findIndex((each) => each.trim() !== '' && indentOf(each) <= indent);
      const body = stop === -1 ? under : under.slice(0, stop);
      const least = Math.min(...body.filter((each) => each.trim() !== '').map(indentOf));
      map[key] = `${header}\n${body
        .map((each) => each.slice(least))
        .join('\n')
        .trimEnd()}`;
    } else if (value === '') map[key] = mapOf(under);
    else if (under.some(says)) throw new Unread(`a value of ${key} over several lines`);
    else map[key] = scalarOf(value);
    i = end;
  }
  return map;
}

/**
 * What a workflow's file declares under `on: workflow_call:`, or undefined when it declares no `workflow_call`: the
 * declaration's own lines, as they are written, and those lines read (`mapOf`), or why the gate does not read them.
 * One that holds an anchor, an alias or a merge key is not read, and is marked `elsewhere`: what it declares is
 * written outside its lines, so the same lines at two commits may declare two things.
 */
export function declarationOf(
  text: string,
): { lines: string; read: Record<string, unknown> } | { lines: string; unread: string; elsewhere?: true } | undefined {
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  const at = all.findIndex((line) => /^(on|'on'|"on")\s*:/.test(line));
  if (at === -1) return undefined;
  const inline = (all[at] ?? '')
    .replace(/^[^:]*:/, '')
    .replace(/(^|\s)#.*$/, '')
    .trim();
  // `on: workflow_call`, or a list of events with it: callable, and nothing declared. Braces could declare anything.
  if (inline !== '') {
    if (!/\bworkflow_call\b/.test(inline)) return undefined;
    return /[{]/.test(inline) ? { lines: inline, unread: '`on:` written on one line' } : { lines: '', read: {} };
  }
  let end = at + 1;
  while (end < all.length && (!says(all[end] ?? '') || indentOf(all[end] ?? '') > 0)) end++;
  const events = all.slice(at + 1, end);
  const first = events.find(says);
  if (first === undefined) return undefined;
  const indent = indentOf(first);
  if (first.trimStart().startsWith('-')) {
    return events.some((line) => /^\s*-\s+workflow_call\s*(#.*)?$/.test(line)) ? { lines: '', read: {} } : undefined;
  }
  const from = events.findIndex(
    (line) =>
      says(line) && indentOf(line) === indent && /^\s*(workflow_call|'workflow_call'|"workflow_call")\s*:/.test(line),
  );
  if (from === -1) return undefined;
  let to = from + 1;
  while (to < events.length && (!says(events[to] ?? '') || indentOf(events[to] ?? '') > indent)) to++;
  const own = (events[from] ?? '')
    .replace(/^[^:]*:/, '')
    .replace(/(^|\s)#.*$/, '')
    .trim();
  const under = events.slice(from + 1, to);
  const lines = [own, ...under].join('\n');
  if ([`workflow_call: ${own}`, ...under].some(refersElsewhere))
    return {
      lines,
      unread: 'an anchor, an alias or a merge key, which says it elsewhere in the file',
      elsewhere: true,
    };
  if (own !== '' && !['{}', 'null', '~'].includes(own))
    return { lines, unread: '`workflow_call:` written on one line' };
  try {
    return { lines, read: (own === '' ? mapOf(under) : null) ?? Object.create(null) };
  } catch (error) {
    if (error instanceof Unread) return { lines, unread: error.message };
    throw error;
  }
}

/** What each part of a declaration holds, as a reason names one. */
const DECLARED = new Map([
  ['inputs', 'input'],
  ['secrets', 'secret'],
  ['outputs', 'output'],
]);

/** A value with its keys in order, and no `description`, which tells a reader and asks nothing of a caller. */
const ordered = (value: unknown): unknown =>
  typeof value !== 'object' || value === null
    ? value
    : Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'description')
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, each]) => [key, ordered(each)]),
      );

/** What differs between two declarations, in words: each input, secret and output added, removed or declared otherwise. */
function declaredOtherwise(was: Record<string, unknown>, now: Record<string, unknown>): string[] {
  const differs: string[] = [];
  const names = (part: unknown) => (typeof part === 'object' && part !== null ? (part as Record<string, unknown>) : {});
  for (const part of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    const [before, after] = [names(was[part]), names(now[part])];
    const what = DECLARED.get(part) ?? part;
    const found = differs.length;
    for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (!Object.hasOwn(before, name)) differs.push(`the ${what} ${name} is added`);
      else if (!Object.hasOwn(after, name)) differs.push(`the ${what} ${name} is removed`);
      else if (JSON.stringify(ordered(before[name])) !== JSON.stringify(ordered(after[name])))
        differs.push(`the ${what} ${name} is declared otherwise`);
    }
    // A part that is not names, such as one emptied: said whole.
    if (differs.length === found && JSON.stringify(ordered(was[part])) !== JSON.stringify(ordered(now[part])))
      differs.push(`its ${part} are declared otherwise`);
  }
  return differs;
}

/** Whose a bump is when what a called workflow declares differs, and what he does. */
const MARTINS =
  "what its caller gives it may have to change with it, so this bump is Martin's, who moves the pin and the caller together";

/**
 * Why a bump of the factory's workflows from one commit to another is not an exact pin by what one of them declares
 * to its callers, or undefined when it declares the same at both: its `on: workflow_call:` declaration (its inputs,
 * secrets and outputs) read at each commit and compared as what it says, not as it is written, so a comment, a
 * description or the order of its keys is no difference. `was` and `now` are the workflow's file at each commit, or
 * undefined where it is not there. A workflow that is gone at the new commit, or declares no `workflow_call` there,
 * differs; where the declaration's lines differ and the gate does not read one of them (`mapOf`), it differs too, as
 * nothing says it does not; and one written with an anchor, an alias or a merge key differs whatever its lines, as
 * what it declares is written outside them.
 *
 * A caller gives a workflow its inputs and secrets and reads its outputs, and a bump moves the commit alone: one that
 * needs the caller changed breaks only once it merges, and what breaks may be the gate that would judge its repair.
 *
 * The limit of this check: it reads what a workflow declares, not what it needs. A workflow that comes to need
 * something of its caller it does not declare is passed: a trigger the caller must run it on (`review.yml` is run on
 * `workflow_run`, which is the caller's to list), a permission the caller's job must grant, a variable or an
 * environment of the caller's repository, a required check's name its ruleset must hold.
 */
export function declaresOtherwise(
  workflow: string,
  { from, to }: { from: string; to: string },
  was: string | undefined,
  now: string | undefined,
): string | undefined {
  const martins = (what: string) => `the factory's ${workflow} ${what}: ${MARTINS}`;
  if (now === undefined) return martins(`is not there at ${short(to)}`);
  if (was === undefined) return martins(`is not there at ${short(from)}, so what it declared there is not known`);
  const [before, after] = [declarationOf(was), declarationOf(now)];
  if (!after) return martins(`declares no workflow_call at ${short(to)}`);
  if (!before) return martins(`declares no workflow_call at ${short(from)}, so what it declared there is not known`);
  // Before the lines are compared: the same lines that say it elsewhere are no proof it is said the same.
  const elsewhere = [
    { at: from, declared: before },
    { at: to, declared: after },
  ].find(({ declared }) => 'elsewhere' in declared);
  if (elsewhere)
    return martins(
      `declares its workflow_call at ${short(elsewhere.at)} with an anchor, an alias or a merge key, so what it declares is outside the lines the gate compares`,
    );
  if (before.lines === after.lines) return undefined;
  const unread = 'unread' in before ? before.unread : 'unread' in after ? after.unread : undefined;
  if ('unread' in before || 'unread' in after)
    return martins(
      `declares its workflow_call in other words at ${short(to)} than at ${short(from)}, which the gate does not read (${unread})`,
    );
  const differs = declaredOtherwise(before.read, after.read);
  if (!differs.length) return undefined;
  const said =
    differs.length > 4 ? `${differs.slice(0, 4).join(', ')}, and ${differs.length - 4} more` : differs.join(', ');
  return martins(`declares otherwise at ${short(to)} than at ${short(from)} (${said})`);
}

/** What an exact pin of the factory's workflows moves: every call, from one commit to one commit. */
export interface WorkflowPin {
  from: string;
  to: string;
  /** The workflows whose calls it moves, by file, in the order GitHub lists them. */
  files: string[];
}

export interface WorkflowPinChecks {
  /**
   * How `head` stands to `base` in the factory's repository, by the compare API (`compare/<base>...<head>`): `ahead`
   * when `head` descends from `base`, `identical`, `behind` when `base` descends from `head`, or `diverged`.
   */
  compare: (base: string, head: string) => Promise<string>;
  /**
   * Every line of the workflows at the pull request's head that names the factory's workflows, a comment's among them,
   * with its file and its number there, from 1.
   */
  calls: () => Promise<{ file: string; number: number; line: string }[]>;
  /** One of the factory's workflows, by its file's name, as a commit of the factory has it, or undefined if it has none. */
  declared: (workflow: string, commit: string) => Promise<string | undefined>;
}

/**
 * Whether a pull request is an exact pin of the factory's workflows: Dependabot's bump of the commit a repository
 * calls them at, and nothing else. Undefined for a change that touches no such call, which is not this rule's to
 * judge; for one that does, its pin, or why it is not an exact one, the first of these that fails:
 *
 * - it is in the app's repository, which calls the factory's workflows by commit: not the factory's own, which calls
 *   none, and no other;
 * - GitHub's Dependabot opened it, from a branch of the repository itself, into `main`;
 * - GitHub lists every file it changes, each a workflow under `.github/workflows/`, modified, whose every changed line
 *   is one call of the factory's workflows (`uses: <the factory>/.github/workflows/<name>.yml@<commit> # main`) that
 *   reads as the line it replaces but for the commit (`callMoves`);
 * - every call it moves goes from one commit to one commit, and no call at its head is left at another (`calls`): a
 *   repository calls every workflow of the factory's at one commit;
 * - the new commit descends from the old (`compare(old, new)` is `ahead`), so the pin moves forward. That alone does
 *   not say whose commit it is: GitHub answers for any commit in the repository's network, a fork's among them;
 * - the new commit is on the factory's `main` (`compare(new, 'main')` is `ahead` or `identical`: `main` descends from
 *   it, or is it). Nothing is signed here for a certificate to say so, as it does for an image, so it is asked. `main`
 *   takes only what Martin merged or the factory merged within what he set, and is never rewritten;
 * - each workflow called at its head declares the same to its callers at the new commit as at the old
 *   (`declaresOtherwise`, which says what that reading does not catch): a bump that may need its caller changed is
 *   Martin's, as no bump of a commit alone can carry that change.
 *
 * A check that could not be made (GitHub not answering) throws, as `checks` do: that is no judgement of the pin.
 */
export async function workflowPin(
  repo: string,
  pr: PullRequest,
  files: readonly FileChange[],
  checks: WorkflowPinChecks,
  complete: boolean,
): Promise<{ moved: WorkflowPin } | { reason: string } | undefined> {
  const touches = files.some((file) => file.patch !== undefined && changedLines(file.patch).some(callsFactory));
  if (!touches) return undefined;
  if (repo === FACTORY_REPO) return { reason: 'the factory calls none of its own workflows by commit' };
  // The exception is the app's alone (ADR 0023, guardrail 10): in any other repository that came to call these
  // workflows, a bump of them is Martin's, as the worker's guards hold its enqueue to the app's too.
  if (repo !== APP_REPO) return { reason: `it is in ${repo}, and only the app's bump of them passes as an exact pin` };
  if (pr.user?.id !== DEPENDABOT) return { reason: 'Dependabot did not open it' };
  if (!fromHere(pr)) return { reason: "it is from a fork's branch" };
  if (pr.base.ref !== 'main') return { reason: `it is into ${pr.base.ref}, not main` };
  if (!complete) return { reason: 'GitHub lists only some of its files, and the rest are unread' };
  const moves: CallMove[] = [];
  for (const file of files) {
    const moved = callMoves(file);
    if (!Array.isArray(moved)) return moved;
    moves.push(...moved);
  }
  const [first] = moves;
  if (!first) return { reason: 'it moves no call' };
  const { from, to } = first;
  const other = moves.find((move) => move.from !== from || move.to !== to);
  if (other)
    return {
      reason: `it moves ${first.file} from ${short(from)} to ${short(to)} and ${other.file} from ${short(other.from)} to ${short(other.to)}: every call moves from one commit to one commit`,
    };
  if (from === to) return { reason: `it leaves the calls at ${short(to)}, the same commit` };
  const called = new Set<string>();
  for (const { file, number, line } of await checks.calls()) {
    const call = WORKFLOW_CALL.exec(line);
    // Any line that names them, a comment among it: said whole, with where it is, as it holds every such bump.
    if (!call)
      return {
        reason: `${file}:${number} at its head names the factory's workflows in a line that is not a call of one at a commit of main (\`${line.trim().slice(0, 120)}\`), which holds every bump of them until it is one, or does not name them`,
      };
    if (call[3] !== to)
      return {
        reason: `${file} at its head still calls the factory at ${short(call[3] ?? '')}: every call moves together`,
      };
    called.add(call[2] ?? '');
  }
  // Read at once with the comparisons, so they add no time to a try; each reason is given in the order above.
  const [forward, onMain, declared] = await Promise.all([
    checks.compare(from, to),
    checks.compare(to, 'main'),
    Promise.all(
      [...called].sort().map(async (workflow) => {
        const [was, now] = await Promise.all([checks.declared(workflow, from), checks.declared(workflow, to)]);
        return { workflow, was, now };
      }),
    ),
  ]);
  if (forward !== 'ahead')
    return {
      reason:
        forward === 'behind'
          ? `${short(to)} is behind ${short(from)}, the commit it replaces: a pin moves forward`
          : forward === 'identical'
            ? `${short(to)} is the commit it replaces`
            : `${short(to)} does not descend from ${short(from)}, the commit it replaces`,
    };
  if (onMain !== 'ahead' && onMain !== 'identical') return { reason: `${short(to)} is not on the factory's main` };
  for (const { workflow, was, now } of declared) {
    const reason = declaresOtherwise(workflow, { from, to }, was, now);
    if (reason) return { reason };
  }
  return { moved: { from, to, files: [...new Set(moves.map((move) => move.file))] } };
}

// The rule

/**
 * What a change is (scripts/move.ts): a move, or why it is not one: `reason` for a change that touches a pin of the
 * scan's moves, which is refused, and `none` for one that touches none, which is no move at all.
 */
export type MoveResult = { rule: 'move' | 'major'; title: string } | { reason: string } | { none: string };

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
  /**
   * The check of an exact pin of the factory's workflows (`workflowPin`), for anyone's pull request but the App's that
   * Martin has not passed and that touches a call of them: what it moves, why it is not an exact pin, or why the check
   * could not be made, after the gate tried again. Undefined for a change that touches none.
   */
  workflows?: { moved: WorkflowPin } | { reason: string } | { unchecked: string };
  /**
   * Whether it is a move (scripts/move.ts), for a pull request from a branch here that Martin has not passed and is no
   * exact pin: `move` or `major` with its verdict's title; why a change that touches the scan's moves is refused, a
   * fact not read among them; why it is no move at all; or, `pending`, why it is not judged yet: the move job judged
   * an earlier head, and the run the push started judges this one.
   */
  move?: MoveResult | { pending: string };
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
  // A risk label someone other than Martin took off holds it, whoever opened it: a move passes without him too.
  if (facts.labelsRemoved.length)
    return held(`Someone other than Martin removed its ${facts.labelsRemoved.join(', ')} label`);
  const { pin, move, workflows } = facts;
  // A check that could not be made is no judgement, of the pin or of its risk: a wait for the gate to judge it again,
  // in either repository, which never passes it and never falls through to its tags.
  const unchecked = (cause_: string): Decision => {
    const cause = `the gate could not check its exact pin: ${cause_}`;
    return {
      ...held(`Not judged yet: ${cause}`),
      pending: cause,
      unchecked: cause_,
      ...(facts.retargeted ? { retargeted: true as const } : {}),
    };
  };
  // Dependabot's bump of the commit the factory's workflows are called at, and nothing else: an exact pin, whatever
  // its tags (`.github/` is Martin's by CODEOWNERS) and with no reading of test integrity, which is the App's rules'
  // alone to need. `workflowPin` holds every condition; who opened it and where are asked again here.
  if (workflows && dependabotOpened(pr) && pr.base.ref === 'main' && repo === APP_REPO) {
    if ('moved' in workflows) {
      const { from, to, files } = workflows.moved;
      const calls = files.length === 1 ? 'call' : `${files.length} calls`;
      return {
        pass: true,
        title: `An exact pin of the factory's workflows: its ${calls} of them move to ${short(to)}, which is on the factory's main and ahead of ${short(from)}`,
        rule: 'exact-pin',
        tags,
      };
    }
    if ('unchecked' in workflows) return unchecked(workflows.unchecked);
  }
  if (appOpened(pr)) {
    if (pin && 'pins' in pin) {
      const images = [...new Set(pin.pins.map((p) => p.image.slice(p.image.lastIndexOf('/') + 1)))];
      return {
        pass: true,
        title: `An exact pin of ${images.join(', ')}, each signed on main`,
        rule: 'exact-pin',
        tags,
      };
    }
    if (pin && 'unchecked' in pin) return unchecked(pin.unchecked);
  }
  // A head the move job has not judged yet is no judgement: a wait, which the run its push started settles.
  if (move && 'pending' in move) return { ...held(`Not judged yet: ${move.pending}`), pending: move.pending };
  // A move is the scan's moves and nothing else, whoever opened it: its tags name the pins' own files, and the level
  // decides who queues it (policy/line.ts).
  if (move && 'rule' in move && fromHere(pr)) return { pass: true, title: move.title, rule: move.rule, tags };
  // Why a change that touches the scan's moves is refused, for anyone's; for the App's, why any change is no move.
  const refused = move && 'reason' in move ? move.reason : undefined;
  if (!appOpened(pr)) {
    // A change that touches a call of the factory's workflows and is no exact pin of them says why, as a change of
    // digests that is no exact pin does: a check that could not be made, of one that is not Dependabot's into main,
    // is a reason too, as nothing would pass it.
    const calls =
      !workflows || 'moved' in workflows ? undefined : 'reason' in workflows ? workflows.reason : workflows.unchecked;
    const notPin = calls && `Not an exact pin of the factory's workflows${refused ? ` (${calls})` : `: ${calls}`}`;
    const notMove = refused && (notPin ? `nor a move: ${refused}` : `Not a move: ${refused}`);
    const why = [notPin, notMove].filter(Boolean).join(', ');
    return { pass: false, title: why ? `${why}: ${lower(martin.title)}` : martin.title, rule: 'held', tags };
  }
  const notMove = refused ?? (move && 'none' in move ? move.none : undefined);
  if (repo !== APP_REPO) {
    const exact = pin && 'reason' in pin ? pin.reason : undefined;
    const why = notMove
      ? `Not an exact pin${exact ? ` (${exact})` : ''}, nor a move: ${notMove}`
      : `Not an exact pin${exact ? `: ${exact}` : ''}`;
    return held(`${why}, and here only a pin or a move passes without Martin`);
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
    const why = notMove ? `; not a move: ${notMove}` : '';
    return held(`Held for its risk tags (${tagNames(tags)})${why}${integrity}`);
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
 *
 * An exact pin of the factory's workflows stands the same way. What its check read is as fixed at a head as an
 * image's signature: the lines the head changes and the calls it holds, and how two commits of the factory stand to
 * each other. Only `main` moves, and only forward, as its ruleset lets nobody rewrite it: a commit that was on it is.
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
