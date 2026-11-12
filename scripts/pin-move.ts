/**
 * A pin move (spec 4.3, ADR 0019): whether a pull request of the factory's App in this repository moves one pin of the
 * vulnerability scan's list forward, and nothing else, proved from the pull request itself, so the review gate passes
 * it as `pin-move` (scripts/review-routing.ts). Every condition is a positive proof, in this order, and the first that
 * cannot be proved holds the pull request for Martin, with the reason:
 *
 * 1. **Pins only.** Every file it changes was there before, with its mode, and changes line for line, each line only
 *    in a version or a digest; nothing under `.github/` and neither of mise's files. The change is what the merge makes,
 *    the head merged onto main's tip, against that tip. The list worked out on both (inventory.ts) has the same items at the same places, and differs in one move's pins alone: one image,
 *    one chart or one value of a chart, from one pin to one other. Every line it changes is one of those pins, and
 *    `--unlisted` finds nothing at the head.
 * 2. **Not what judges.** Trivy's, Syft's and Kyverno's own pins are Martin's: what judges a move cannot vouch for its
 *    own replacement, and Kyverno is what says, on the platform check's cluster, that admission enforces.
 * 3. **Signed where its publisher signs.** An image of ours passes only as an exact pin, signed by build.yml on main. A
 *    third-party image is held to its digest alone, as admission admits it (ADR 0010): the next condition's.
 * 4. **Forward on its line.** The gate resolves the target itself, as the scan does (deadlines.ts's `newestOf`): the
 *    same tag at its index digest now, or the newest tag on its line at its index digest now, never a major and never
 *    back; a chart's later version on the same major, in its repository's index.
 * 5. **No record goes stale.** Each refusal record's hash (scripts/policy-hash.ts), computed at the base and at the
 *    head, is the same.
 * 6. **Nothing else that runs changes.** For a chart, a value or an image the cluster runs, the manifests rendered at
 *    the base and at the head differ only in the moved image's references and the chart's own version labels.
 * 7. **The scans show it.** The pinned Trivy, on a fresh database, on the image as it was and as it would be, on
 *    linux/amd64 and linux/arm64 each apart: a finding (its advisory and package, never its path) with a fix is gone,
 *    and nothing is new at High or above. An index without a platform, or a scan that read nothing, proves nothing.
 * 8. **Something ran it.** GitHub Actions' latest run at the head of the job that runs what the pin runs succeeded,
 *    not skipped, in this repository's own workflow that has that job, on the pull request: `ZAP scan` for ZAP's image,
 *    `image builds` for a Dockerfile's stage, each shard of `tests` for Postgres, whose pin CI's own database is. What a
 *    cluster runs (a chart, a value, a third-party image in deploy/, Postgres too) passes only once `platform` made a
 *    cluster from the change and everything on it ran; a `platform` skipped made none. Argo CD's chart, which `make up`
 *    installs, is held, and k3s waits for Martin, whose cluster moves with it. Last, so such a hold says every other
 *    condition held.
 *
 * It trusts nothing the pull request says of itself (its title, label, description or branch): the move is worked out
 * from its two commits, and the code that works it out (the list, the policy hash, the Trivy pin) is the gate's own,
 * main's, never the head's. The head is data: its lines are read before anything renders it, and only a change of
 * versions and digests on the base's own lines gets as far as kustomize or Helm. A fact that could not be read (a
 * registry that did not answer, a scan that read nothing, a check skipped rather than succeeded) is no proof: it holds.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compareVersions, newestOf } from '../apps/factory/src/vulnerabilities/deadlines.ts';
import { readTarget, type Target, targetText } from '../apps/factory/src/vulnerabilities/fixes.ts';
import {
  type Chart,
  type Item,
  inventory,
  type Kind,
  type Unlisted,
  unlisted,
} from '../apps/factory/src/vulnerabilities/inventory.ts';
import { isMajor } from '../apps/factory/src/vulnerabilities/moves.ts';
import { DB_MAX_AGE_MS, databases, realTools, repositoryOf } from '../apps/factory/src/vulnerabilities/scan.ts';
import { trivyPin } from '../apps/factory/src/vulnerabilities/trivy-pin.ts';
import { PROFILE, RECORDS, type RecordName, render, taken } from './policy-hash.ts';

/** A place in a file: where a pin is written. */
export interface Place {
  file: string;
  line: number;
}

/** A line the change rewrites, at the same place before and after. */
export interface LineChange extends Place {
  before: string;
  after: string;
}

/** What one pin of the move is: an image's reference, a chart's version, or the digest a chart's value sets. */
export type What = 'image' | 'chart' | 'value';

/** One pin the move writes: where, what it pins before and after, and the item of the list it belongs to. */
export interface Moved {
  what: What;
  /** The list's item: its kind and name at the base. */
  kind: Kind;
  item: string;
  place: Place;
  from: string;
  to: string;
  /** For a chart or a value: the chart, at the base and at the head. */
  chart?: { base: Chart; head: Chart };
}

/** The move a pull request makes, once the list shows it is one. */
export interface Move {
  what: What;
  /** What moves: an image's repository, a chart's name, or a chart's value. */
  name: string;
  kind: Kind;
  from: string;
  to: string;
  pins: Moved[];
}

/** A check run, as the checks API lists them for a commit. */
export interface Run {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app: { slug: string } | null;
  check_suite?: { id: number } | null;
  /**
   * The workflow file whose run made it, as `workflowsOf` reads it from its check suite: only a run of this repository,
   * on a pull request from this repository, at the run's own head. Anything else, or unread, is null.
   */
  workflow?: string | null;
}

/** A workflow run, as the Actions API lists them for a commit: the one fact that ties a check run to its file. */
export interface WorkflowRun {
  id: number;
  path: string;
  event: string;
  head_sha: string;
  check_suite_id: number;
  repository: { full_name: string } | null;
  head_repository: { full_name: string } | null;
  /** The pull requests GitHub ran it for: this repository's open ones at the head, none once they closed. */
  pull_requests?: { number: number; base: { ref: string } }[] | null;
}

/** The pull request a check must have run for: its number, and whether it is open (a replay by hand is not). */
export interface For {
  number: number;
  open: boolean;
}

/** What a Trivy report says, as far as the rule reads it. */
export interface Scan {
  /** Whether it read anything: a report with no results read nothing, and proves nothing. */
  read: boolean;
  /** Each finding by its advisory and its package's name: where in the image it was found is never part of it. */
  findings: { id: string; pkg: string; path?: string; severity: string; fixed: boolean }[];
}

/** Everything the rule reads, so the tests give it answers instead. Each may throw: a fact not read holds. */
export interface PinMoveIO {
  /** The change from the merge base to the head: git's `--raw` list, and each modified file's text at both commits. */
  diff(): Promise<{ raw: string; files: Rewritten[] }>;
  /** The scan's list, at the merge base or at the head. */
  list(side: Side): Promise<Item[]>;
  /** What the list does not read, at the head. */
  unlisted(): Promise<Unlisted[]>;
  /** Every tag of an image's repository. */
  tags(repository: string): Promise<string[]>;
  /** An image's index digest now, as `scripts/ci-images.sh current` reads one. */
  digest(reference: string): Promise<string>;
  /** A chart's versions in its repository's index. */
  chartVersions(repo: string, chart: string): Promise<string[]>;
  /** A chart rendered with its values from one side's tree. */
  render(side: Side, chart: Chart): Promise<string>;
  /** The overlay the cluster runs, rendered from one side's tree. */
  overlay(side: Side): Promise<string>;
  /** Each refusal record's policy hash, from one side's tree. */
  hashes(side: Side): Promise<Record<string, string>>;
  /** Trivy's report of an image on one platform; one the index does not have is an error, and holds. */
  scan(reference: string, platform: string): Promise<Scan>;
  /** The check runs at the head, each with the workflow that made it (`workflowsOf`). */
  runs(): Promise<Run[]>;
}

export type Side = 'base' | 'head';

export type PinMoveResult = { move: Move; ran: string[]; fixed: number } | { reason: string };

/** The platforms an image is scanned on: what CI runs (amd64) and what the local cluster runs (arm64). */
export const PLATFORMS = ['linux/amd64', 'linux/arm64'];

/** GitHub Actions, the one app whose check runs are the workflows'. */
export const ACTIONS = 'github-actions';

/** The jobs of check.yml that run what a pin runs, by the place of the pin. `tests` is a matrix of shards. */
export const ZAP_CHECK = 'ZAP scan';
export const IMAGE_CHECK = 'image builds';
export const TEST_SHARDS = ['tests (1/3)', 'tests (2/3)', 'tests (3/3)'];
/** platform.yml's job that makes a cluster from the change and passes once everything on it runs. */
export const PLATFORM_CHECK = 'platform';

export const CHECK_WORKFLOW = '.github/workflows/check.yml';
export const PLATFORM_WORKFLOW = '.github/workflows/platform.yml';
/** The workflow each check must come from: a job of the same name in any other workflow ran something else. */
export const WORKFLOW_OF: Readonly<Record<string, string>> = {
  [ZAP_CHECK]: CHECK_WORKFLOW,
  [IMAGE_CHECK]: CHECK_WORKFLOW,
  ...Object.fromEntries(TEST_SHARDS.map((name) => [name, CHECK_WORKFLOW])),
  [PLATFORM_CHECK]: PLATFORM_WORKFLOW,
};

/** ZAP's image, which the browser tests' scan starts: `ZAP scan` runs it. */
export const ZAP_FILE = 'apps/console/zap/scan.ts';
/** The Postgres the cluster runs, whose pin CI's own database is (scripts/ci-images.sh postgres): `tests` run it. */
export const POSTGRES_FILE = 'deploy/base/postgres/statefulset.yaml';

/** What judges a move, whose own pins are Martin's to move: none of them can vouch for its replacement. */
const JUDGES: { name: string; test: (moved: Moved) => boolean }[] = [
  // Kyverno is admission itself: on the platform check's cluster it is what says every image policy enforces and
  // `make admission-ready` passes, so it cannot vouch for its own replacement either.
  {
    name: 'Kyverno',
    test: (m) => m.item === 'kyverno' || /(^|\/)kyverno\//.test(m.from),
  },
  {
    name: 'Trivy',
    test: (m) => m.place.file.startsWith('deploy/images/trivy/') || /(^|\/)aquasec(urity)?\/trivy([:@]|$)/.test(m.from),
  },
  {
    name: 'Syft',
    test: (m) => m.place.file.startsWith('deploy/images/syft/') || /(^|\/)anchore\/syft([:@]|$)/.test(m.from),
  },
];

const MISE_FILES = new Set(['mise.toml', 'mise.lock']);

/** A version as a tag or a chart writes one (`2.17.0`, `v1.37.2-k3s1`, `18.6-alpine3.24`), or a digest's hex. */
const VERSION_WORD = /^v?\d+(\.\d+)*([-+][A-Za-z0-9.+-]*)?$/;
const HEX_WORD = /^[0-9a-f]{64}$/;
const WORDS = /[A-Za-z0-9._+-]+/g;

const short = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);

/** An image reference's tag and digest, each if it has one. */
export function tagAndDigest(reference: string) {
  const [name = '', digest] = reference.split('@');
  const repository = repositoryOf(reference);
  return { tag: name.length > repository.length ? name.slice(repository.length + 1) : undefined, digest };
}

/**
 * Whether a line changes only in versions and digests: the same words and the same text between them, each word that
 * differs a version or a digest's hex. An image's name, a key, a registry or anything else written differently is not a
 * pin's change.
 */
export function onlyPinsChange(before: string, after: string): boolean {
  if (before === after) return false;
  const split = (text: string) => ({ words: text.match(WORDS) ?? [], between: text.split(WORDS) });
  const a = split(before);
  const b = split(after);
  if (a.words.length !== b.words.length || a.between.join('\0') !== b.between.join('\0')) return false;
  return a.words.every((word, i) => {
    const other = b.words[i] as string;
    if (word === other) return true;
    return (VERSION_WORD.test(word) && VERSION_WORD.test(other)) || (HEX_WORD.test(word) && HEX_WORD.test(other));
  });
}

/** A file the change modifies, whole, as each commit has it: blobs read by git, never a patch's text. */
export interface Rewritten {
  path: string;
  before: string;
  after: string;
}

/**
 * The lines a change rewrites, from git's `--raw` list of the files it changes and each modified file's text at both
 * commits, or why it is not a change of pins' lines: each file modified in place, regular, with its mode, as many lines
 * before as after, and each line that differs only in versions and digests. Nothing under `.github/`, and neither of
 * mise's files. The two texts are compared line by line, never read from a patch, whose `+++` and `---` a line's own
 * text could imitate.
 */
export function lineChanges(raw: string, files: readonly Rewritten[]): { lines: LineChange[] } | { reason: string } {
  const entries = raw.split('\n').filter((line) => line.startsWith(':'));
  if (entries.length === 0) return { reason: 'it changes no file' };
  const paths: string[] = [];
  for (const entry of entries) {
    const [meta = '', ...rest] = entry.split('\t');
    const [modeA, modeB, , , status] = meta.slice(1).split(' ');
    const path = rest.join('\t');
    if (path.startsWith('.github/'))
      return { reason: `it changes ${path}: a pin under .github/ is a workflow's, and the App writes none` };
    if (MISE_FILES.has(path))
      return { reason: `it changes ${path}: mise's files move only when someone upgrades the toolchain` };
    if (status !== 'M')
      return {
        reason: `${path} is ${status === 'A' ? 'added' : status === 'D' ? 'deleted' : `changed (${status})`}, not modified in place`,
      };
    if (modeA !== modeB || !/^100(644|755)$/.test(modeA ?? ''))
      return { reason: `${path} changes its mode, or is not a regular file` };
    paths.push(path);
  }
  const lines: LineChange[] = [];
  for (const path of paths) {
    const file = files.find((each) => each.path === path);
    if (!file) return { reason: `the gate did not read ${path} at both commits` };
    if (file.before.includes('\0') || file.after.includes('\0')) return { reason: `${path} is binary` };
    const [a, b] = [file.before.split('\n'), file.after.split('\n')];
    if (a.length !== b.length)
      return {
        reason: `${path} adds or removes a line rather than rewriting one (${a.length} lines before, ${b.length} after)`,
      };
    const before = lines.length;
    for (const [i, was] of a.entries()) {
      const now = b[i] as string;
      if (was === now) continue;
      if (!onlyPinsChange(was, now))
        return { reason: `${path}:${i + 1} changes more than a version or a digest: ${short(now.trim())}` };
      lines.push({ file: path, line: i + 1, before: was, after: now });
    }
    if (lines.length === before) return { reason: `${path} rewrites no line` };
  }
  return { lines };
}

const placeKey = (place: Place) => `${place.file}:${place.line}`;

/**
 * The pins the list moves between the base and the head, or why the two lists are not one move apart: the same items
 * in the same order at the same places, each the same but in what it pins.
 */
export function listMoves(base: readonly Item[], head: readonly Item[]): { moved: Moved[] } | { reason: string } {
  if (base.length !== head.length)
    return {
      reason: `the list has ${head.length} items at the head and ${base.length} at the base: it adds or removes one`,
    };
  const moved: Moved[] = [];
  for (const [i, was] of base.entries()) {
    const now = head[i] as Item;
    const at = `${was.file}:${was.line}`;
    if (now.kind !== was.kind || now.file !== was.file || now.line !== was.line)
      return { reason: `the list's ${was.kind} at ${at} is not at the same place at the head` };
    if (was.image !== undefined || now.image !== undefined) {
      if (!was.image || !now.image || repositoryOf(was.image) !== repositoryOf(now.image))
        return { reason: `${at} names another image at the head: ${short(now.image ?? 'none')}` };
      if (was.image !== now.image)
        moved.push({
          what: 'image',
          kind: was.kind,
          item: was.name,
          place: { file: was.file, line: was.line },
          from: was.image,
          to: now.image,
        });
    }
    if (was.chart || now.chart) {
      const [b, h] = [was.chart, now.chart];
      if (
        !b ||
        !h ||
        b.repo !== h.repo ||
        b.chart !== h.chart ||
        b.release !== h.release ||
        b.values.join('\n') !== h.values.join('\n')
      )
        return {
          reason: `${was.name}'s chart at ${at} is not the same chart, from the same repository, with the same values`,
        };
      if (b.version !== h.version)
        moved.push({
          what: 'chart',
          kind: was.kind,
          item: was.name,
          place: { file: was.file, line: was.line },
          from: b.version,
          to: h.version,
          chart: { base: b, head: h },
        });
      const [bp, hp] = [was.pins ?? [], now.pins ?? []];
      if (bp.length !== hp.length || bp.some((p, j) => placeKey(p) !== placeKey(hp[j] as Place)))
        return { reason: `${was.name}'s values pin images at other places at the head` };
      for (const [j, p] of bp.entries()) {
        const q = hp[j] as typeof p;
        if (p.digest !== q.digest)
          moved.push({
            what: 'value',
            kind: was.kind,
            item: was.name,
            place: { file: p.file, line: p.line },
            from: p.digest,
            to: q.digest,
            chart: { base: b, head: h },
          });
      }
    }
    if (!was.image && !was.chart && was.name !== now.name)
      return { reason: `${at} names ${short(now.name)} at the head` };
  }
  if (!moved.length) return { reason: 'the list moves no pin between the base and the head' };
  return { moved };
}

/** The move the pins make, or why they are more than one: one item, one pin's name, from one value to one other. */
export function oneMove(moved: readonly Moved[]): { move: Move } | { reason: string } {
  const [first, ...rest] = moved;
  if (!first) return { reason: 'the list moves no pin' };
  const nameOf = (m: Moved) =>
    m.what === 'image'
      ? repositoryOf(m.from)
      : m.what === 'chart'
        ? m.item
        : `${m.item}'s value at ${placeKey(m.place)}`;
  const second = rest.find(
    (m) => m.what !== first.what || nameOf(m) !== nameOf(first) || m.from !== first.from || m.to !== first.to,
  );
  if (second) return { reason: `a second pin in the same change: ${nameOf(second)} beside ${nameOf(first)}` };
  return {
    move: { what: first.what, name: nameOf(first), kind: first.kind, from: first.from, to: first.to, pins: [...moved] },
  };
}

/** Whether every line the change rewrites is a pin the move writes, and every pin it writes is a line it rewrites. */
export function onlyItsPins(lines: readonly LineChange[], move: Move): string | undefined {
  const pins = new Set(move.pins.map((m) => placeKey(m.place)));
  const other = lines.find((line) => !pins.has(placeKey(line)));
  if (other) return `${placeKey(other)} is a line that is not a pin of ${move.name}: ${short(other.after.trim())}`;
  for (const m of move.pins) {
    const line = lines.find((each) => placeKey(each) === placeKey(m.place));
    if (!line) return `${placeKey(m.place)}, a pin of ${move.name}, is not a line it rewrites`;
    // The pin's own text, and nothing else on its line: the line as it was, with that one span written anew.
    if (!rewritesOnly(line, m))
      return `${placeKey(m.place)} changes more than ${move.name}'s pin: ${short(line.after.trim())}`;
  }
  return undefined;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a line is its old text with the pin's span alone replaced: the reference, the version, or a value's tag and digest. */
function rewritesOnly(line: LineChange, m: Moved): boolean {
  const span = (text: string, value: string) => {
    const found = [...text.matchAll(new RegExp(`${m.what === 'value' ? '(?:[\\w.-]+@)?' : ''}${literal(value)}`, 'g'))];
    return found.length === 1 ? found[0]?.[0] : undefined;
  };
  const was = span(line.before, m.from);
  const now = span(line.after, m.to);
  return was !== undefined && now !== undefined && line.before.replace(was, now) === line.after;
}

/** The tag a value's line writes beside its digest (`tag: 2.14.3@sha256:…`), if it writes one. */
const valueTag = (line: string) => /^\s*(?:tag|digest):\s*['"]?([\w.-]+)@sha256:/.exec(line)?.[1];

/** The image a chart's rendering runs at a digest: the one reference there that carries it. */
function imageAt(rendered: string, digest: string): string | undefined {
  const found = new Set<string>();
  for (const line of rendered.split('\n')) {
    const image = /^\s*(?:-\s+)?image:\s*['"]?([a-z0-9][\w./:@-]*)['"]?\s*(?:#.*)?$/i.exec(line)?.[1];
    if (image?.endsWith(`@${digest}`)) found.add(image);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Whether an image's move is forward on its line, resolved by the gate: the same tag at its index digest now, or the
 * newest tag on its line (`newestOf`, as the scan resolves a fix) at its index digest now. Never back, never a major,
 * never a digest the tag does not name.
 */
export async function imageForward(
  from: string,
  to: string,
  io: Pick<PinMoveIO, 'tags' | 'digest'>,
): Promise<string | undefined> {
  const repository = repositoryOf(from);
  const was = tagAndDigest(from);
  const now = tagAndDigest(to);
  if (!was.tag || !now.tag) return `${repository} is pinned by digest alone: no tag to resolve the move by`;
  if (!now.digest) return `${short(to)} is not pinned by digest`;
  const target: Target = { kind: 'image', tag: now.tag, digest: now.digest };
  // The grammar the scan writes a fix in: a tag it cannot write is no target the scan would name.
  const read = readTarget(targetText(target));
  if (read?.kind !== 'image' || read.tag !== now.tag || read.digest !== now.digest)
    return `${short(to)} is not a target the scan's grammar writes`;
  if (now.tag !== was.tag) {
    const order = compareVersions(now.tag, was.tag);
    if (!/^v?\d/.test(now.tag) || !/^v?\d/.test(was.tag))
      return `${now.tag} is another tag than ${was.tag}, which is not a version`;
    if (order < 0) return `a move backwards, from ${was.tag} to ${now.tag}`;
    if (major(now.tag) !== major(was.tag)) return `a major, from ${was.tag} to ${now.tag}`;
    const newest = await newestOf(from, io.tags);
    if (!newest?.version) return `${was.tag} names no line the gate can resolve`;
    if (newest.tag !== now.tag) return `${now.tag} is not the newest tag on ${was.tag}'s line, ${newest.tag}`;
  }
  const current = await io.digest(`${repository}:${now.tag}`);
  if (current !== now.digest)
    return `a digest that is not the tag's: ${repository}:${now.tag} is ${current.slice(0, 19)} now, not ${now.digest.slice(0, 19)}`;
  return undefined;
}

const major = (version: string) => Number(/\d+/.exec(version)?.[0] ?? Number.NaN);

/** Whether a chart's move is to a later version on the same major, which its repository's index has. */
export async function chartForward(move: Move, io: Pick<PinMoveIO, 'chartVersions'>): Promise<string | undefined> {
  const chart = move.pins[0]?.chart?.head;
  if (!chart) return `${move.name} names no chart`;
  if (compareVersions(move.to, move.from) <= 0) return `a move backwards, from ${move.from} to ${move.to}`;
  if (!/^v?\d+(\.\d+)*$/.test(move.to)) return `${chart.chart} ${move.to} is a prerelease, not a release`;
  const target: Target = {
    kind: 'chart',
    chart: chart.chart,
    version: move.to,
    major: major(move.to) !== major(move.from),
  };
  // The scan's rule for a chart's major is the flag its fix carries, set from the versions' first numbers as here.
  if (isMajor(target, move.from)) return `a major, from ${move.from} to ${move.to}`;
  const read = readTarget(targetText(target));
  if (read?.kind !== 'chart' || read.version !== move.to)
    return `${move.to} is not a version the scan's grammar writes`;
  const versions = await io.chartVersions(chart.repo, chart.chart);
  if (!versions.includes(move.to)) return `${chart.repo} has no ${chart.chart} ${move.to}`;
  return undefined;
}

/**
 * What runs a pin, by its place: the check runs at the head that must have succeeded, or why none runs it, so it is
 * held. A pin in deploy/ the cluster runs from the change itself (a chart, its value, a third-party image) needs
 * `platform`, which makes a cluster from the change; Postgres needs it beside `tests`, which run the same pin as CI's
 * database. An image of ours never gets here (condition 3), and a Dockerfile's stage in deploy/ builds an image the
 * cluster runs only once build.yml has built it on main, which no check at the head does.
 */
export function whatRunsIt(move: Move): { checks: string[] } | { reason: string } {
  const files = new Set(move.pins.map((m) => m.place.file));
  const only = (file: string) => files.size === 1 && files.has(file);
  if (move.kind === 'k3s' || move.kind === 'k3s-release' || move.kind === 'k3d')
    return {
      reason: `${move.name} is the cluster's own: a k3s move waits for Martin, whose cluster moves with it, whatever the platform check says`,
    };
  if (move.what === 'image' && move.kind === 'workflow' && only(ZAP_FILE)) return { checks: [ZAP_CHECK] };
  if (move.what === 'image' && move.kind === 'dockerfile' && [...files].every((f) => !f.startsWith('deploy/')))
    return { checks: [IMAGE_CHECK] };
  if (files.has('Makefile')) return { reason: `${move.name} is installed by make up: a merge does not apply it` };
  const inDeploy = [...files].every((f) => f.startsWith('deploy/'));
  if (move.what === 'image' && move.kind === 'third-party' && only(POSTGRES_FILE))
    return { checks: [...TEST_SHARDS, PLATFORM_CHECK] };
  if (inDeploy && (move.kind === 'chart' || (move.what === 'image' && move.kind === 'third-party')))
    return { checks: [PLATFORM_CHECK] };
  return { reason: `no check at the head runs ${move.name}: nothing shows it ran` };
}

/** The kinds whose pods the platform check holds to running and ready (scripts/platform-pods.sh). */
const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

/**
 * Whether a cluster made from the change starts an image: some document of the rendering that names it is a
 * Deployment, StatefulSet or DaemonSet, not a hook (Helm's or Argo CD's) and not scaled to nothing. An image only a
 * hook, a Job or a CronJob runs, or one no workload names, is never pulled by the platform check, which then proves
 * nothing of it.
 */
export function started(rendered: string, references: readonly string[]): string | undefined {
  const documents = rendered.split(/^---\s*$/m);
  for (const reference of references) {
    const naming = documents.filter((doc) => doc.includes(reference));
    const runs = naming.some((doc) => {
      const kind = /^kind:\s*(\S+)/m.exec(doc)?.[1] ?? '';
      return (
        WORKLOADS.has(kind) &&
        !/^\s+(helm\.sh\/hook|argocd\.argoproj\.io\/hook)\s*:/m.test(doc) &&
        !/^ {2}replicas:\s*['"]?0['"]?\s*$/m.test(doc)
      );
    });
    if (!runs)
      return `no workload the platform check runs starts ${short(reference)}: a hook, a Job or nothing at all runs it, so its cluster never pulled it`;
  }
  return undefined;
}

/**
 * The check runs at the head, each with the workflow file that made it, read from the workflow run of its check suite:
 * a run of this repository (`repo`), on `pull_request`, from a branch of this repository, at the check run's own head,
 * for this pull request into main. A check run whose suite is not such a run (another app's, a fork's, another event's,
 * another head's, or one run for another pull request at the same head, into another base) has none. GitHub empties a
 * run's pull requests once they close, so a replay of a closed one by hand takes a run that names none.
 */
export function workflowsOf(checks: readonly Run[], workflows: readonly WorkflowRun[], repo: string, pr: For): Run[] {
  return checks.map((run) => {
    const suite = run.check_suite?.id;
    const made = workflows.find((w) => suite !== undefined && w.check_suite_id === suite);
    const ours =
      made &&
      made.repository?.full_name === repo &&
      made.head_repository?.full_name === repo &&
      made.event === 'pull_request' &&
      made.head_sha === run.head_sha &&
      ((made.pull_requests ?? []).some((p) => p.number === pr.number && p.base.ref === 'main') ||
        (!pr.open && !made.pull_requests?.length));
    return { ...run, workflow: ours ? made.path : null };
  });
}

/**
 * Whether each check ran at the head and succeeded: GitHub Actions' latest run of each name at the head, from the
 * workflow that has that job (`WORKFLOW_OF`), completed, a success. A run of the same name from anywhere else counts
 * for nothing; skipped, cancelled or failed is no success.
 */
export function ranIt(runs: readonly Run[], head: string, checks: readonly string[]): string | undefined {
  for (const name of checks) {
    const workflow = WORKFLOW_OF[name];
    if (!workflow) return `the gate knows no workflow that runs ${name}`;
    const named = runs.filter((run) => run.name === name && run.head_sha === head && run.app?.slug === ACTIONS);
    const latest = named.filter((run) => run.workflow === workflow).sort((a, b) => b.id - a.id)[0];
    if (!latest)
      return named.length
        ? `${name} at ${head.slice(0, 7)} ran in no run of ${workflow} for this pull request that the gate could read`
        : `${name} has not run at ${head.slice(0, 7)}`;
    if (latest.status !== 'completed') return `${name} has not finished at ${head.slice(0, 7)}`;
    if (latest.conclusion !== 'success')
      return `${name} at ${head.slice(0, 7)} is ${latest.conclusion ?? 'unfinished'}, not a success: ${
        name === PLATFORM_CHECK && latest.conclusion === 'skipped'
          ? 'it made no cluster from the change'
          : 'something must run it'
      }`;
  }
  return undefined;
}

/** The records whose hash differs between the two sides, or a reason when the two do not name the same records. */
export function staleRecords(base: Record<string, string>, head: Record<string, string>): string | undefined {
  const names = Object.keys(base).sort();
  if (!names.length) return 'the gate read no refusal record to hold the change to';
  if (names.join('\n') !== Object.keys(head).sort().join('\n'))
    return 'the head names other refusal records than the base';
  const stale = names.filter((name) => base[name] !== head[name]);
  if (stale.length)
    return `it stales ${stale.map((name) => `deploy/test/${name}.json`).join(', ')}: the policies' hash moves, and a record is taken again on a cluster`;
  return undefined;
}

/**
 * Two renderings with the moved image's references and the chart's own version labels written the same, so that what
 * is left of a difference is something else that runs. Another image's line stays as it is: a change to it is a change.
 */
export function normalised(rendered: string, references: readonly string[]): string[] {
  const refs = [...new Set(references.filter(Boolean))].sort((a, b) => b.length - a.length);
  return rendered.split('\n').map((line) => {
    let text = line;
    for (const ref of refs) text = text.split(ref).join('<image>');
    // The chart's own version labels, by their exact keys: any other key, a `chart:` an Application installs among
    // them, is compared.
    return text.replace(/^(\s*(?:helm\.sh\/chart|app\.kubernetes\.io\/version):\s*).*$/, '$1<version>');
  });
}

/** Whether two renderings differ in anything but the moved image and the chart's version labels. */
export function manifestsDiffer(base: string, head: string, references: readonly string[]): string | undefined {
  const [a, b] = [normalised(base, references), normalised(head, references)];
  if (!a.join('').trim() || !b.join('').trim()) return 'a rendering came out empty: nothing to compare';
  if (a.length !== b.length)
    return `the manifests rendered at the head have ${b.length} lines, at the base ${a.length}`;
  const at = a.findIndex((line, i) => line !== b[i]);
  if (at >= 0) return `the manifests change beyond the image: ${short((b[at] as string).trim())}`;
  return undefined;
}

const HIGH = new Set(['HIGH', 'CRITICAL']);

/** Whether the scans show the move: a finding with a fix gone, and nothing new at High or above, in every image. */
export function scansShow(
  pairs: readonly { from: string; to: string; was: Scan; now: Scan }[],
): { fixed: number } | { reason: string } {
  // Each finding fixed counted once, whichever platforms it was fixed on.
  const gone = new Set<string>();
  for (const { from, to, was, now } of pairs) {
    if (!was.read) return { reason: `the scan of ${short(from)} read nothing` };
    if (!now.read) return { reason: `the scan of ${short(to)} read nothing` };
    // A finding is its advisory and its package, never its path: one still there at another path is not gone.
    const key = (f: Scan['findings'][number]) => `${f.id}\0${f.pkg.split(' ')[0]}`;
    const _before = new Set(was.findings.map(key));
    // New is strict: the same advisory in the same package at a path it was not at before is new.
    const where = (f: Scan['findings'][number]) => `${key(f)}\0${f.path ?? ''}`;
    const beforeAt = new Set(was.findings.map(where));
    const after = new Set(now.findings.map(key));
    for (const f of was.findings) if (f.fixed && !after.has(key(f))) gone.add(key(f));
    const brought = now.findings.find((f) => HIGH.has(f.severity.toUpperCase()) && !beforeAt.has(where(f)));
    if (brought) return { reason: `a target that brings a new ${brought.severity.toUpperCase()}: ${short(to)}` };
  }
  if (gone.size === 0) return { reason: 'the scans show no finding with a fix gone: the move fixes nothing' };
  return { fixed: gone.size };
}

/** The image references before and after each moved image, for the scans and the renderings. */
async function imagePairs(move: Move, io: PinMoveIO): Promise<{ from: string; to: string }[] | string> {
  if (move.what === 'image') return [{ from: move.from, to: move.to }];
  const chart = move.pins[0]?.chart;
  if (!chart) return `${move.name} names no chart`;
  const [was, now] = await Promise.all([io.render('base', chart.base), io.render('head', chart.head)]);
  if (move.what === 'value') {
    const from = imageAt(was, move.from);
    const to = imageAt(now, move.to);
    if (!from || !to) return `${move.name}'s rendering runs no one image at its digest`;
    return [{ from, to }];
  }
  // A chart: each image its rendering runs at the head that it did not at the base, beside the one it replaces.
  const images = (text: string) =>
    new Set(
      text
        .split('\n')
        .flatMap((line) => /^\s*(?:-\s+)?image:\s*['"]?([a-z0-9][\w./:@-]*)['"]?\s*$/i.exec(line)?.[1] ?? []),
    );
  const [before, after] = [images(was), images(now)];
  const pairs: { from: string; to: string }[] = [];
  for (const to of after) {
    if (before.has(to)) continue;
    const from = [...before].find((each) => repositoryOf(each) === repositoryOf(to) && !after.has(each));
    if (!from) return `${move.name} ${move.to} runs an image ${move.from} did not: ${short(to)}`;
    pairs.push({ from, to });
  }
  for (const from of before)
    if (!after.has(from) && !pairs.some((p) => p.from === from))
      return `${move.name} ${move.to} no longer runs ${short(from)}`;
  if (!pairs.length) return `${move.name} ${move.to} runs the same images as ${move.from}: nothing to scan`;
  return pairs;
}

/** The pin move a change makes, proved, or the first condition that could not be proved. */
export async function pinMove(reader: PinMoveIO, head: string): Promise<PinMoveResult> {
  // Each chart rendered once on each side: the images it runs and the manifests it makes are read from the same.
  const renders = new Map<string, Promise<string>>();
  const io: PinMoveIO = {
    ...reader,
    render: (side, chart) => {
      const key = JSON.stringify([side, chart]);
      let once = renders.get(key);
      if (!once) {
        once = reader.render(side, chart);
        renders.set(key, once);
      }
      return once;
    },
  };
  // 1. Pins only: the text first, so nothing renders a head that changes more than versions and digests.
  const { raw, files } = await io.diff();
  const changes = lineChanges(raw, files);
  if ('reason' in changes) return changes;
  // Each changed line one of the base's pins before the head is rendered at all: only a pin's line reaches kustomize.
  const base = await io.list('base');
  const pins = new Set(base.flatMap((item) => [placeKey(item), ...(item.pins ?? []).map(placeKey)]));
  const stranger = changes.lines.find((line) => !pins.has(placeKey(line)));
  if (stranger) return { reason: `${placeKey(stranger)} is a line that is not a pin: ${short(stranger.after.trim())}` };
  const now = await io.list('head');
  const listed = listMoves(base, now);
  if ('reason' in listed) return listed;
  const one = oneMove(listed.moved);
  if ('reason' in one) return one;
  const { move } = one;
  const stray = onlyItsPins(changes.lines, move);
  if (stray) return { reason: stray };
  for (const m of move.pins) {
    const line = changes.lines.find((l) => placeKey(l) === placeKey(m.place));
    if (m.what === 'value' && !valueTag(line?.after ?? ''))
      return { reason: `${placeKey(m.place)} writes no tag beside its digest to resolve` };
  }
  const unread = await io.unlisted();
  if (unread.length)
    return {
      reason: `the list does not read ${unread.length} pin${unread.length === 1 ? '' : 's'} at the head: ${short(`${unread[0]?.file}:${unread[0]?.line} ${unread[0]?.reference}`)}`,
    };
  // 2. Not what judges.
  const judge = JUDGES.find((j) => move.pins.some(j.test));
  if (judge)
    return { reason: `${judge.name}'s own pin: what judges cannot vouch for its replacement, so it is Martin's` };
  // 3. Signed where its publisher signs: an image of ours passes as an exact pin, or not at all.
  if (move.what === 'image' && /^ghcr\.io\/the-roganator\//.test(move.from))
    return {
      reason: `${move.name} is an image of ours, which passes only as an exact pin, signed by build.yml on main`,
    };
  // 4. Forward on its line.
  if (move.what === 'chart') {
    const backward = await chartForward(move, io);
    if (backward) return { reason: backward };
  }
  const pairs = await imagePairs(move, io);
  if (typeof pairs === 'string') return { reason: pairs };
  if (move.what !== 'chart') {
    for (const { from, to } of pairs) {
      const backward = await imageForward(from, to, io);
      if (backward) return { reason: backward };
    }
  }
  // 5. No record goes stale.
  const [hashBase, hashHead] = await Promise.all([io.hashes('base'), io.hashes('head')]);
  const stale = staleRecords(hashBase, hashHead);
  if (stale) return { reason: stale };
  // 6. Nothing else that runs changes: a chart's or a value's chart rendered, or the overlay for an image in deploy/.
  const references = pairs.flatMap(({ from, to }) => [from, to, from.split('@')[1] ?? '', to.split('@')[1] ?? '']);
  const chart = move.pins[0]?.chart;
  if (chart || move.pins.some((m) => m.place.file.startsWith('deploy/'))) {
    const [was, after] = chart
      ? await Promise.all([io.render('base', chart.base), io.render('head', chart.head)])
      : await Promise.all([io.overlay('base'), io.overlay('head')]);
    const differ = manifestsDiffer(was, after, references);
    if (differ) return { reason: differ };
  }
  // 7. The scans show it.
  // Each platform we run apart, so a High new on one is never hidden by the other's findings.
  const scanned = await Promise.all(
    pairs.flatMap(({ from, to }) =>
      PLATFORMS.map(async (platform) => ({
        from: `${from} (${platform})`,
        to: `${to} (${platform})`,
        was: await io.scan(from, platform),
        now: await io.scan(to, platform),
      })),
    ),
  );
  const shown = scansShow(scanned);
  if ('reason' in shown) return shown;
  // 8. Something ran it, last: a pin a cluster runs waiting on `platform` is held so with every other condition
  // proved, and its hold then says that the check is all it waits for.
  const runs = whatRunsIt(move);
  if ('reason' in runs) return runs;
  if (runs.checks.includes(PLATFORM_CHECK)) {
    const rendered = chart ? await io.render('head', chart.head) : await io.overlay('head');
    const unstarted = started(
      rendered,
      pairs.map(({ to }) => to),
    );
    if (unstarted) return { reason: unstarted };
  }
  const notRun = ranIt(await io.runs(), head, runs.checks);
  if (notRun) return { reason: notRun };
  return { move, ran: runs.checks, fixed: shown.fixed };
}

/** A pin move's verdict, in one line. */
export function moveTitle(result: { move: Move; ran: string[]; fixed: number }) {
  const { move, ran, fixed } = result;
  const to =
    move.what === 'image'
      ? (tagAndDigest(move.to).tag ?? move.to.slice(0, 19))
      : move.what === 'value'
        ? move.to.slice(0, 19)
        : move.to;
  const by = [...new Set(ran.map((r) => (r.startsWith('tests (') ? 'tests' : r)))].join(' and ');
  return `A pin move of ${move.name} to ${to}, forward on its line: ${fixed} finding${fixed === 1 ? '' : 's'} with a fix gone, none new at High, ${by} ran it`;
}

// The gate's readers, as review.yml has them: git, kustomize, yq and Helm from mise, Trivy in its pinned image through
// Docker, the registries over HTTP. Each is main's code, run on the two commits as data.

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');

/** A registry's answer to an image's name, anonymously, with the token it asks for. */
async function registry(repository: string, path: string, accept?: string): Promise<Response> {
  const [first = '', ...rest] = repository.split('/');
  const hosted = repository.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const host = hosted ? first : 'registry-1.docker.io';
  const name = hosted ? rest.join('/') : repository.includes('/') ? repository : `library/${repository}`;
  const url = `https://${host}/v2/${name}/${path}`;
  const get = (token?: string) =>
    fetch(url, {
      headers: { ...(accept ? { accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  // A registry's moment (a 429, a 5xx, a dropped connection) is asked again, as the scan's reads are.
  let answer: Response | undefined;
  for (const wait of [0, 5_000, 15_000]) {
    if (wait) await new Promise((done) => setTimeout(done, wait));
    try {
      answer = await get();
      if (answer.status !== 429 && answer.status < 500) break;
    } catch (error) {
      if (wait === 15_000) throw error;
    }
  }
  if (!answer) throw new Error(`${host} did not answer for ${name}`);
  if (answer.status === 401) {
    const challenge = answer.headers.get('www-authenticate') ?? '';
    const field = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(challenge)?.[1];
    const realm = field('realm');
    if (!realm) throw new Error(`${host} asked for a token, and said nowhere to get one`);
    const query = new URLSearchParams({
      service: field('service') ?? host,
      scope: field('scope') ?? `repository:${name}:pull`,
    });
    const auth = await fetch(`${realm}?${query}`, { signal: AbortSignal.timeout(30_000) });
    if (!auth.ok) throw new Error(`${host} gave no token to read ${name}: ${auth.status}`);
    const body = (await auth.json()) as { token?: string; access_token?: string };
    answer = await get(body.token ?? body.access_token);
  }
  if (!answer.ok) throw new Error(`${host} answered ${answer.status} for ${name}'s ${path.split('?')[0]}`);
  return answer;
}

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface RealOptions {
  repo: string;
  /**
   * The base branch's tip, the merge base and the head, as full SHAs. The move is proved on what the merge makes: the
   * head's change merged onto the tip, against the tip, never against a merge base main has moved on from.
   */
  base: string;
  mergeBase: string;
  head: string;
  /** Where the commits are fetched from: the repository on GitHub, unless a test names a local one. */
  remote?: string;
  /** The check runs at the head, each with the workflow that made it, read through the API by the gate. */
  runs: () => Promise<Run[]>;
}

/** The readers on two commits of `repo`, fetched into a directory of their own, as data. */
export async function realPinMoveIO(options: RealOptions): Promise<PinMoveIO & { close(): void }> {
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'pin-move-'));
  const git = (...args: string[]) =>
    exec('git', ['-C', join(work, 'repo'), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
  mkdirSync(join(work, 'repo'));
  await git('init', '--quiet');
  await git(
    'fetch',
    '--quiet',
    '--depth=1',
    '--no-tags',
    options.remote ?? `https://github.com/${options.repo}.git`,
    ...new Set([options.base, options.mergeBase, options.head]),
  );
  // What the merge makes: the head's change onto the base's tip, from their merge base. A conflict is no move to prove.
  const tree = await git('merge-tree', '--write-tree', `--merge-base=${options.mergeBase}`, options.base, options.head)
    .then(({ stdout }) => stdout.trim().split('\n')[0] ?? '')
    .catch(() => {
      throw new Error(`the head does not merge onto ${options.base.slice(0, 7)} without a conflict`);
    });
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('git wrote no tree of the merge');
  const merged = (
    await git(
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=pin move',
      '-c',
      'user.email=pin-move@localhost',
      'commit-tree',
      tree,
      '-p',
      options.base,
      '-m',
      'the merge, as data',
    )
  ).stdout.trim();
  const sides: Record<Side, string> = { base: options.base, head: merged };
  const dirs: Record<Side, string> = { base: join(work, 'base'), head: join(work, 'head') };
  await git('worktree', 'add', '--quiet', '--detach', dirs.base, sides.base);
  await git('worktree', 'add', '--quiet', '--detach', dirs.head, sides.head);
  const tools = realTools(trivyImage(), join(work, 'cache'), work);
  mkdirSync(join(work, 'cache'));
  let pulled: Promise<unknown> | undefined;
  return {
    close: () => rmSync(work, { recursive: true, force: true }),
    async diff() {
      const raw = (await git('diff', '--raw', '--no-renames', '--no-abbrev', sides.base, sides.head)).stdout;
      // Each modified file's blob at both commits, as bytes git stores: no patch to parse, no filter or driver run.
      const show = async (sha: string, path: string) => (await git('cat-file', 'blob', `${sha}:${path}`)).stdout;
      const files: Rewritten[] = [];
      for (const entry of raw.split('\n').filter((line) => / M\t/.test(line))) {
        const path = entry.split('\t').slice(1).join('\t');
        files.push({ path, before: await show(sides.base, path), after: await show(sides.head, path) });
      }
      return { raw, files };
    },
    list: async (side) => inventory(dirs[side]).items,
    unlisted: async () => unlisted(dirs.head),
    async tags(repository) {
      const tags: string[] = [];
      let path = 'tags/list?n=1000';
      for (let page = 0; page < 50; page++) {
        const answer = await registry(repository, path);
        const body = (await answer.json()) as { tags?: unknown };
        if (!Array.isArray(body.tags)) throw new Error(`${repository}'s registry gave no list of tags`);
        tags.push(...body.tags.filter((t): t is string => typeof t === 'string'));
        const next = /<[^>]*\/v2\/[^>]*\/(tags\/list\?[^>]*)>;\s*rel="next"/.exec(
          answer.headers.get('link') ?? '',
        )?.[1];
        if (!next) return tags;
        path = next;
      }
      throw new Error(`${repository} has more pages of tags than the gate reads`);
    },
    async digest(reference) {
      const { tag } = tagAndDigest(reference);
      if (!tag) throw new Error(`${reference} names no tag`);
      const answer = await registry(repositoryOf(reference), `manifests/${tag}`, MANIFESTS);
      return `sha256:${createHash('sha256')
        .update(Buffer.from(await answer.arrayBuffer()))
        .digest('hex')}`;
    },
    async chartVersions(repo, chart) {
      if (!/^https:\/\/[\w.-]+(\/[\w.~-]+)*\/?$/.test(repo))
        throw new Error(`${repo} is not an HTTPS chart repository`);
      const answer = await fetch(`${repo.replace(/\/$/, '')}/index.yaml`, { signal: AbortSignal.timeout(60_000) });
      if (!answer.ok) throw new Error(`${repo} answered ${answer.status} for its index`);
      const text = await answer.text();
      const child = exec(
        'yq',
        ['eval', '--output-format=json', '--indent=0', '[.entries[strenv(CHART)][] | .version]', '-'],
        {
          env: { ...process.env, CHART: chart },
          maxBuffer: 256 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
        },
      );
      child.child.stdin?.end(text);
      const versions = JSON.parse((await child).stdout) as unknown;
      if (!Array.isArray(versions)) throw new Error(`${repo} lists no versions of ${chart}`);
      return versions.filter((v): v is string => typeof v === 'string');
    },
    render: (side, chart) => tools.render(chart, dirs[side]),
    async overlay(side) {
      const { stdout } = await exec('kustomize', ['build', join(dirs[side], 'deploy/overlays/local')], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      });
      return stdout;
    },
    hashes: (side) => hashesOf(dirs[side]),
    async scan(reference, platform) {
      pulled ??= databases(tools, trivyImage(), join(work, 'cache'));
      // As the daily scan refuses one: findings read from a stale database prove nothing new is High.
      const age = await pulled;
      if (typeof age !== 'number' || age > DB_MAX_AGE_MS)
        throw new Error(`the advisory database is refused: ${typeof age === 'string' ? age : 'it is too old'}`);
      const { digest } = tagAndDigest(reference);
      const target = digest ? `${repositoryOf(reference)}@${digest}` : reference;
      const report = await tools.retry(() =>
        tools.trivy(['image', '--scanners', 'vuln', '--image-src', 'remote', '--platform', platform, '--', target]),
      );
      const results = report.Results ?? [];
      return {
        read: results.length > 0,
        findings: results.flatMap((result) =>
          (result.Vulnerabilities ?? []).map((v) => ({
            id: v.VulnerabilityID ?? '',
            pkg: v.PkgName ?? '',
            path: v.PkgPath ?? '',
            severity: v.Severity ?? 'UNKNOWN',
            fixed: Boolean(v.FixedVersion),
          })),
        ),
      };
    },
    runs: options.runs,
  };
}

/**
 * Each refusal record's policy hash, as the gate's own policy-hash.ts (main's) computes it from a tree's deploy/: what
 * a record holds, so a move that changes one stales that record.
 */
export async function hashesOf(root: string): Promise<Record<string, string>> {
  const manifests = render(PROFILE, root);
  return Object.fromEntries(
    (Object.keys(RECORDS) as RecordName[]).map((record) => [record, taken(record, manifests).policyHash]),
  );
}

/** The Trivy image the gate's own checkout pins (deploy/images/trivy/Dockerfile), never the head's. */
function trivyImage() {
  const pinned = trivyPin(readFileSync(join(ROOT, 'deploy/images/trivy/Dockerfile'), 'utf-8'))?.[1];
  if (!pinned) throw new Error("the gate's checkout pins no Trivy it can read");
  return pinned;
}
