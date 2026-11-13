/**
 * Each open finding's deadline, worked out afresh on every run from what the scan read, the registries and code
 * scanning, with no state of its own; and the run's verdict on them. With `--memo`, the registries' and the releases'
 * answers are asked once a day and kept in that file for the day's other runs (memo.ts); code scanning, and Trivy on
 * the scan's database, are read every run.
 *
 *     node apps/factory/src/vulnerabilities/deadlines.ts <scan's out dir> --checkout <dir> --trivy-pin <Dockerfile>
 *       (--write | --prove) [--memo <file> [--memo-day <YYYY-MM-DD>]]
 *
 * - **Severity** is the higher of Trivy's and the publisher's (`Finding.publisher`: Trivy's `VendorSeverity` for the
 *   advisory's own source, or Node's own rating for Node's).
 * - **The fix is installable** from the first fixed version's publish time in npm's registry plus the scanned
 *   repository's `minimumReleaseAge` (pnpm's default of a day where it sets none), for an npm package of ours: a
 *   lockfile's, or one in an image of ours that a lockfile of ours resolves at that version. For Node, from the first patched release
 *   in Node's release index. For anything else in an image (an operating system's package, a binary it ships), from
 *   the creation of the newest image on the line of the pin that brings it (the runtime stage of its Dockerfile, for an
 *   image of ours), found as `scripts/ci-images.sh`'s `newest` finds it, or the tag's current image for a tag that is
 *   not a version, once that image no longer has the finding. An image that arrives only with a k3s release is
 *   installable from the day the first k3s release after the pin on its Kubernetes minor (its node image's tags) was
 *   published whose `k3s-images.txt` lists a copy without the finding. In an image of ours, only what its runtime stage's image
 *   has comes that way; anything else its Dockerfile adds, but an npm package, has no fix to count from. A package in
 *   several versions is installable once every copy's fix is, and Node's fix is a release on the major installed. Only
 *   an image with such a finding that Trivy says is fixed has its line's newest scanned, each once, and nothing is
 *   uploaded for it; a newest that gives no time it was made (a reproducible build says 1970) gives no day. While no
 *   fix is installable there is no deadline.
 * - **The clock starts** on the later of the fix being installable and the creation of the finding's alert, read from
 *   code scanning with the job's token; a finding with no alert before today is first seen today. A rename keeps its
 *   clock: when an item is new to the list, and an alert of the same package and advisory belongs to an item no longer
 *   on it (open, or closed by this run's upload), the new finding takes that alert's day. An exception's expiry does
 *   not restart it: an excepted finding's alert is dismissed, not closed, and keeps its day. Critical 2 days, High 7,
 *   Medium 30, Low 90; a finding no source rates takes Low's. An excepted finding has no deadline.
 * - **The run fails** on a new High or Critical (first seen today) with a fix installable, on one due within a day,
 *   and on one past its deadline, after the upload, so a new finding's alert exists. A new one with no fix the scan
 *   can date is counted on its own and fails nothing, so a failed run always means a move not yet made. `--prove`, a
 *   proving run's, which uploads nothing, fails on none of them. A source that cannot be read (npm, Node's index, an image line's tags or its newest image,
 *   code scanning) fails either, as an unread item fails the scan.
 *
 * The log and the step summary give counts alone, never a package or an advisory: by severity, and by overdue, due
 * within a day, within a week, later, and no fix. Node runs this with no dependencies, from a sparse checkout of this
 * repository; Trivy runs in its pinned image, as the scan runs it, on the scan's database.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { retried } from '../gates/retry.ts';
import { type Alert, alertsIn, isOurs, realApi } from './alerts.ts';
import { type Fix, type MoveTag, readFix, type Target, writable } from './fixes.ts';
import { type Chart, identity, type Kind } from './inventory.ts';
import { dayOf, type MemoCount, memoised, readMemo, writeMemo } from './memo.ts';
import {
  APP,
  type Context,
  type DayCounts,
  dependabotDirectories,
  directPackages,
  type Judged,
  type Move,
  moves,
  movesFile,
  table as movesTable,
  publicMove,
  type ScannedImage,
} from './moves.ts';
import { satisfies } from './node.ts';
import { DIGEST, DIGEST_PATTERN, hasRegistry, repositoryOf, splitReference } from './reference.ts';
import {
  alertKey,
  type Finding,
  fingerprint,
  messageOf,
  overLimits,
  type Sarif,
  SEVERITIES,
  type Severity,
} from './sarif.ts';
import {
  apiVersionsOf,
  type Handoff,
  imagesIn,
  PULL_WAITS,
  type ReadTarget,
  realTools,
  type TrivyReport,
  trivyPin,
} from './scan.ts';

const run = promisify(execFile);
const DAY = 86_400_000;

/** How long a finding has from its clock's start, in days, by its severity. */
export const DAYS: Record<Severity, number> = { CRITICAL: 2, HIGH: 7, MEDIUM: 30, LOW: 90, UNKNOWN: 90 };

/** pnpm's own `minimumReleaseAge`, in minutes, where the repository sets none. */
const PNPM_DEFAULT_MINUTES = 24 * 60;

const NODE_INDEX = 'https://nodejs.org/dist/index.json';

/** The earliest time an image may say it was made: before it, the build set none (a reproducible one says 1970). */
const EARLIEST = Date.parse('2000-01-01T00:00:00Z');

/** Trivy's types of an npm package. */
const NPM_TYPES = new Set(['pnpm', 'npm', 'yarn', 'node-pkg']);

/** k3s's node image, whose tags name its releases (`v1.37.1-k3s1` for `v1.37.1+k3s1`). */
const K3S_IMAGE = 'rancher/k3s';

/**
 * The k3s releases after a pinned one on its line, oldest first, from the node image's tags (`v1.37.2-k3s1` is
 * `v1.37.2+k3s1`): the same Kubernetes minor, any build, no release candidate. Moving to another minor is an upgrade
 * of Kubernetes, not the fix.
 */
export function k3sLine(pinned: string, tags: string[]) {
  const [, minor, patch, build] = /^(v\d+\.\d+)\.(\d+)\+k3s(\d+)$/.exec(pinned) ?? [];
  if (!minor) return [];
  const after = (p: number, b: number) => p > Number(patch) || (p === Number(patch) && b > Number(build));
  return tags
    .map((tag) => /^(v\d+\.\d+)\.(\d+)-k3s(\d+)$/.exec(tag))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === minor && after(Number(m[2]), Number(m[3])))
    .sort((a, b) => Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3]))
    .map((m) => `${m[1]}.${m[2]}+k3s${m[3]}`);
}

/** Whether two references name one repository, Docker Hub's written with its registry or without. */
const bareName = (reference: string) => reference.replace(/^docker\.io\/(library\/)?/, '');

/** Whether two references name one image: the same repository and tag (or digest). */
const sameImage = (a: string, b: string) => bareName(a) === bareName(b);

const sameRepository = (a: string, b: string) => {
  const bare = (reference: string) => repositoryOf(reference).replace(/^docker\.io\/(library\/)?/, '');
  return bare(a) === bare(b);
};

/** A k3s release's version, from the URL of its list of images (inventory.ts's `list`). */
export function k3sReleaseOf(list: string) {
  const version = /^https:\/\/github\.com\/k3s-io\/k3s\/releases\/download\/([^/]+)\/k3s-images\.txt$/.exec(list)?.[1];
  return version ? decodeURIComponent(version) : undefined;
}

/** What the deadlines are read from, so the tests give recorded answers instead. */
export interface Sources {
  /** When npm published a version of a package, or undefined when npm has no such version. */
  published(name: string, version: string): Promise<string | undefined>;
  /** Node's releases, from its release index: each version with its day. */
  releases(): Promise<{ version: string; date: string }[]>;
  /** Every tag of an image's repository. */
  tags(repository: string): Promise<string[]>;
  /** Trivy's report of an image. */
  image(reference: string): Promise<TrivyReport>;
  /** An image's index digest, as `scripts/ci-images.sh current` reads one: the SHA-256 of its raw manifest. */
  digest(reference: string): Promise<string>;
  /** An image's index digest, and every platform manifest it lists (none for a single manifest). */
  manifests(reference: string): Promise<{ digest: string; platforms: string[] }>;
  /** A chart's versions in its repository's index, each with when it was published. */
  chartVersions(repo: string, chart: string): Promise<{ version: string; created: string }[]>;
  /** A chart, rendered as the scan renders it, with its values files from the checkout. */
  render(chart: Chart, kubeVersion?: string): Promise<string>;
  /** A tool's releases, from its publisher's repository, as mise.lock names it, each with when it was published. */
  toolReleases(tool: string): Promise<{ version: string; published: string }[]>;
  /** Trivy's report of a tool's release, as mise.lock's download for linux-x64 at that version; none if not built. */
  tool(tool: string, version: string): Promise<TrivyReport | undefined>;
  /** A k3s release (`v1.37.2+k3s1`): when it was published, and the images its `k3s-images.txt` lists. */
  k3s(release: string): Promise<{ published: string; images: string[] } | undefined>;
  /** A file of the scanned checkout, or undefined. */
  file(path: string): string | undefined;
  /** The scan's alerts: open, dismissed, and closed as fixed. */
  alerts(): Promise<Alert[]>;
}

/** The higher of Trivy's rating and the publisher's. */
export function severityOf(finding: Pick<Finding, 'severity' | 'publisher'>): Severity {
  const { severity, publisher } = finding;
  return publisher && SEVERITIES.indexOf(publisher) < SEVERITIES.indexOf(severity) ? publisher : severity;
}

// Versions, as npm and Trivy write them: numbers, then a prerelease that sorts before the release.
const parts = (version: string) => {
  const [release = '', ...pre] = version.trim().replace(/^v/, '').split('-');
  return { numbers: release.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre.join('-') };
};

export function compareVersions(a: string, b: string) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.numbers.length, y.numbers.length); i++) {
    const d = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The first fixed version above what is installed, from Trivy's list of fixed versions, or undefined. */
export function firstFixed(installed: string, fixed: string | undefined) {
  if (!fixed) return undefined;
  const [lowest] = installed.split(', ').filter(Boolean).sort(compareVersions);
  return fixed
    .split(/,\s*/)
    .map((version) => version.trim())
    .filter((version) => /^v?\d/.test(version) && (!lowest || compareVersions(version, lowest) > 0))
    .sort(compareVersions)[0];
}

type Route = 'npm' | 'node' | 'image' | 'tool' | 'none';

/** How a finding's fix reaches us: through npm, Node's releases, a newer image on its pin's line, or a tool's release. */
function routeOf(
  finding: Pick<Finding, 'type'>,
  kind: ReadTarget['kind'],
  fromBase = false,
  inLockfile = false,
  fromTool = false,
): Route {
  if (finding.type === 'node') return 'node';
  if (kind === 'lockfile') return 'npm';
  if (kind !== 'ours') return 'image';
  // An image of ours: what its runtime stage's image has comes with a newer one; an npm package a lockfile of ours
  // resolves, through npm; one a tool in mise.toml brings, with the tool's release; anything else its Dockerfile adds
  // itself, which no newer base brings, has no fix to count from.
  if (fromBase) return 'image';
  if (NPM_TYPES.has(finding.type) && inLockfile) return 'npm';
  return fromTool ? 'tool' : 'none';
}

/** A reference's name and tag, its digest left off. */
function nameAndTag(reference: string) {
  const { repository, tag } = splitReference(reference);
  return { repository, tag };
}

/**
 * The newest tag on a tag's line, as `scripts/ci-images.sh`'s `newest` finds it: the same first number, as many
 * numbers, and the same prefix (none or `v`) and suffix (24.21.0-alpine3.24 → 24.x.y-alpine3.24), the tag Dependabot
 * would move the pin to. Undefined for a tag that is not a version.
 */
export function newestOnLine(tag: string, tags: string[]) {
  const line = tagLine(tag);
  if (!line) return undefined;
  return tags
    .filter((each) => line.pattern.test(each))
    .sort((a, b) => compareVersions(a.slice(line.prefix.length), b.slice(line.prefix.length)))
    .at(-1);
}

/**
 * What a pin's tag names now: for a version, the newest tag on its line (`newestOnLine`), and for any other tag, that
 * tag, whose image is what it names today; undefined for a pin with no tag. The one way a target is resolved: the scan
 * takes a fix from it, and the review gate (scripts/pin-move.ts) holds a pin move to it.
 */
export async function newestOf(pin: string, listTags: (repository: string) => Promise<string[]>) {
  const { repository, tag } = nameAndTag(pin);
  if (!tag) return undefined;
  // A version's newest on its line; any other tag, the image it names now.
  if (!tagLine(tag)) return { reference: `${repository}:${tag}`, tag, version: false };
  const latest = newestOnLine(tag, await listTags(repository)) ?? tag;
  return { reference: `${repository}:${latest}`, tag: latest, version: true };
}

/** A tag's line, or undefined for a tag that is not a version. */
function tagLine(tag: string) {
  const head = tag.split('-')[0] ?? '';
  const prefix = /^\D*/.exec(head)?.[0] ?? '';
  const version = head.slice(prefix.length);
  if (!/^v?$/.test(prefix) || !/^\d+(\.\d+)*$/.test(version)) return undefined;
  const suffix = tag.slice(prefix.length + version.length);
  const [major, ...rest] = version.split('.');
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    prefix,
    pattern: new RegExp(`^${prefix}${major}${rest.map(() => '\\.[0-9]+').join('')}${literal(suffix)}$`),
  };
}

/** The image a Dockerfile's last stage is built on, following its stages back to the one that names an image. */
export function runtimeStage(dockerfile: string) {
  const joined = dockerfile.replace(/\\\r?\n/g, ' ');
  const stages: { image: string; alias?: string | undefined }[] = [];
  for (const line of joined.split('\n')) {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (from?.[1]) stages.push({ image: from[1], alias: from[2]?.toLowerCase() });
  }
  let image = stages.at(-1)?.image;
  for (let hops = 0; image && hops < stages.length; hops++) {
    const earlier = stages.find((stage) => stage.alias === image?.toLowerCase());
    if (!earlier) return image;
    image = earlier.image;
  }
  return undefined;
}

/**
 * The Dockerfile that builds an image of ours, by the names `build.yml` gives them: `<name>` from `apps/<name>/Dockerfile`,
 * `<a>-<b>` from `apps/<a>/Dockerfile.<b>` or `apps/<b>/Dockerfile`, or the repository's own `Dockerfile`.
 */
export function dockerfileOf(image: string, exists: (path: string) => boolean) {
  const name = repositoryOf(image).split('/').at(-1) ?? '';
  const [a, ...b] = name.split('-');
  const rest = b.join('-');
  const candidates = [
    `apps/${name}/Dockerfile`,
    ...(rest ? [`apps/${a}/Dockerfile.${rest}`, `apps/${rest}/Dockerfile`] : []),
    'Dockerfile',
  ];
  return candidates.find(exists);
}

/** The parts of a finding, or an alert, that a clock is matched by: never its line, its version or its digest. */
interface Place {
  advisory: string;
  file: string;
  package: string;
  /** The item's repository: a lockfile's path, or an image's name without its tag or digest. */
  repository: string;
}

/** The digest `findingsOf` writes after an image's reference in its label. */
const LABEL_DIGEST = new RegExp(String.raw` \(${DIGEST_PATTERN}\)$`);
const itemOf = (label: string) => repositoryOf(label.replace(LABEL_DIGEST, ''));
const placeOf = (finding: Finding): Place => ({
  advisory: finding.advisory,
  file: finding.file,
  package: finding.package,
  repository: itemOf(finding.label),
});

/** An alert's place, read from its rule and its latest message (sarif.ts's `messageOf`), or undefined. */
function alertPlace(alert: Alert): Place | undefined {
  const advisory = alert.rule?.id ?? '';
  const text = alert.most_recent_instance?.message?.text ?? '';
  const file = alert.most_recent_instance?.location?.path ?? '';
  const space = text.indexOf(' ');
  const into = text.indexOf(' in ', space);
  const end = text.lastIndexOf(`: ${advisory} (`);
  if (!advisory || !file || space < 1 || into < 0 || end <= into) return undefined;
  return { advisory, file, package: text.slice(0, space), repository: itemOf(text.slice(into + 4, end)) };
}

/**
 * What a rename keeps: the package and the advisory, and the image's repository (a pin moved to another file), or that
 * it is a lockfile (one moved to another path). An image of another repository is another item, never a rename.
 */
const renameKey = (place: Place) =>
  JSON.stringify([place.package, place.advisory, place.repository === place.file ? 'lockfile' : place.repository]);

/**
 * How far from the next alert's making an alert may have closed and still be one upload's split of a result: code
 * scanning processes an upload's 20 categories one by one, so a result that moved category opens in one and closes in
 * another, a minute or more apart, either way round (seen: opened 20:38:29, closed 20:39:30). A real fix and the
 * finding's return are two uploads, each a scan of at least five minutes, and a day apart as the schedule runs them.
 */
const SPLIT = 10 * 60_000;

const placeKey = (place: Place) => JSON.stringify([place.advisory, place.file, place.package, place.repository]);
const itemKey = (place: Pick<Place, 'file' | 'repository'>) => JSON.stringify([place.file, place.repository]);
const time = (text: string | null | undefined) => (text ? Date.parse(text) : Number.NaN);

type Bucket = 'overdue' | 'day' | 'week' | 'later' | 'none';

/** One result's deadline, as the run judges it. */
export interface Row {
  finding: Finding;
  severity: Severity;
  excepted: boolean;
  /** When its fix became installable, or undefined while none is. */
  installable?: number | undefined;
  /** When it was first seen: its alert's creation, a renamed item's, or now. */
  seen: number;
  firstSeenToday: boolean;
  due?: number | undefined;
  bucket: Bucket;
}

/** What moving a result writes: the kind of item the pin is, its name, where it is, and what it pins now (moves.ts). */
export interface Where {
  kind: Kind;
  name: string;
  pin: { file: string; line: number };
  from: string;
}

/** How old a non-version tag's image may be and still be a line someone builds. */
export const UNBUILT_DAYS = 180;

/** How many majors past a chart's pinned one are rendered for a fix, at most. */
const CHART_MAJORS = 3;

/** How many versions of one chart's major, or of a tool's range, are tried for a fix, newest first, at most. */
const CANDIDATES = 4;

/** A tool in mise.toml whose release brings a package into an image of ours, from where Trivy found it (`opt/pnpm/…`). */
export function toolOf(path: string | undefined, tools: string[]) {
  const name = /^\/?opt\/([\w.-]+)\//.exec(path ?? '')?.[1];
  return name && tools.includes(name) ? name : undefined;
}

/** The tools mise.lock holds, with each one's version. */
export function miseTools(lock: string | undefined) {
  const found = new Map<string, string>();
  let tool: string | undefined;
  for (const line of (lock ?? '').split('\n')) {
    const header = /^\[\[tools\.([\w.-]+|"[^"]+")\]\]$/.exec(line.trim());
    if (header?.[1]) {
      tool = header[1].replace(/"/g, '');
      continue;
    }
    const version = /^version = "([^"]+)"$/.exec(line.trim())?.[1];
    if (tool && version && !found.has(tool)) found.set(tool, version);
  }
  return found;
}

/** A tool's range in mise.toml (`pnpm = "12"`), or undefined. */
export function miseRange(toml: string | undefined, tool: string) {
  let inTools = false;
  for (const line of (toml ?? '').split('\n')) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (section !== undefined) {
      inTools = section.trim() === 'tools';
      continue;
    }
    const m = /^\s*"?([\w.:/-]+)"?\s*=\s*"([^"]+)"/.exec(line);
    if (inTools && m?.[1] === tool) return m[2];
  }
  return undefined;
}

/** The line a Dockerfile's `FROM <image>` is on, or 0. */
const fromLine = (dockerfile: string, image: string) =>
  dockerfile
    .split('\n')
    .findIndex((line) =>
      new RegExp(`^\\s*FROM\\s+(?:--\\S+\\s+)*${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(line),
    ) + 1;

/** What an image pins, as a move's `from`: its tag, or its digest when it has none. */
const pinned = (reference: string) => {
  const { tag } = nameAndTag(reference);
  const { digest } = splitReference(reference);
  return tag ?? digest ?? reference;
};

/**
 * When each result's fix became installable, and what fixes it, by its index in `findings`, from the sources; and
 * where moving it writes.
 */
export async function installable(
  findings: Finding[],
  targets: ReadTarget[],
  sources: Sources,
  minimumReleaseAge = PNPM_DEFAULT_MINUTES,
  log: (line: string) => void = () => {},
  now = Date.now(),
  kubeVersion?: string,
) {
  const kinds = new Map(targets.map((target) => [target.key, target]));
  const at: (number | undefined)[] = findings.map(() => undefined);
  const fixes: (Target | undefined)[] = findings.map(() => undefined);
  const places: Where[] = [];
  const lines = { npm: 0, images: 0, k3s: { fixed: 0, none: 0 }, charts: 0, tools: 0, unbuilt: 0 };
  const has = (pkg: string, advisory: string) => JSON.stringify([pkg, advisory]);
  // What each image the scan read has, by its reference without its tag, so an image of ours can tell what its
  // runtime stage brings from what its Dockerfile adds.
  const byImage = new Map<string, Set<string>>();
  for (const finding of findings) {
    const image = kinds.get(finding.item)?.image;
    if (!image) continue;
    const found = byImage.get(identity(image)) ?? new Set<string>();
    found.add(has(finding.package, finding.advisory));
    byImage.set(identity(image), found);
  }
  const tools = miseTools(sources.file('mise.lock'));
  // npm: each package and version once; each repository's tags once; each line's newest once.
  const npm = new Map<string, Promise<string | undefined>>();
  const tags = new Map<string, Promise<string[]>>();
  let releases: Promise<{ version: string; date: string }[]> | undefined;
  const newest = new Map<string, Promise<{ created?: number | undefined; has: Set<string> }>>();
  const pins = new Map<string, { image: string; dockerfile: string; line: number } | undefined>();
  /** The pin whose line brings a target's image findings: its own, or its Dockerfile's runtime stage for one of ours. */
  const stageOf = (target: ReadTarget) => {
    if (pins.has(target.key)) return pins.get(target.key);
    let stage: { image: string; dockerfile: string; line: number } | undefined;
    if (target.kind === 'ours') {
      const dockerfile = dockerfileOf(target.image ?? '', (path) => sources.file(path) !== undefined);
      const text = dockerfile ? (sources.file(dockerfile) ?? '') : '';
      const image = dockerfile ? runtimeStage(text) : undefined;
      if (dockerfile && image) stage = { image, dockerfile, line: fromLine(text, image) || 1 };
      else
        log(
          `::warning::No Dockerfile's runtime stage was found for ${repositoryOf(target.image ?? '')}: its image findings have no fix to count from.`,
        );
    }
    pins.set(target.key, stage);
    return stage;
  };
  const pinOf = (target: ReadTarget) => (target.kind === 'ours' ? stageOf(target)?.image : target.image);
  const listTags = (repository: string) => {
    let listed = tags.get(repository);
    if (!listed) {
      listed = sources.tags(repository);
      tags.set(repository, listed);
    }
    return listed;
  };
  // The k3s releases after a pinned one on its line, oldest first, each read once.
  const k3sLines = new Map<string, Promise<string[]>>();
  const k3sReleases = new Map<string, Promise<{ published: string; images: string[] } | undefined>>();
  const k3sAfter = (list: string) => {
    let once = k3sLines.get(list);
    if (!once) {
      once = (async () => {
        const pinnedRelease = k3sReleaseOf(list);
        if (!pinnedRelease) {
          log(`::warning::No k3s release could be read from ${list}: the images it lists have no fix to count from.`);
          return [];
        }
        return k3sLine(pinnedRelease, await listTags(K3S_IMAGE));
      })();
      k3sLines.set(list, once);
    }
    return once;
  };
  const k3sRelease = (release: string) => {
    let once = k3sReleases.get(release);
    if (!once) {
      once = sources.k3s(release);
      k3sReleases.set(release, once);
    }
    return once;
  };
  /** The first k3s release after the pinned one whose copy of the image no longer has the finding, and its day. */
  const k3sFix = async (target: ReadTarget, finding: Finding) => {
    if (!target.list) {
      log(
        `::warning::${repositoryOf(target.image ?? '')} came with a k3s release the scan named no list for: no fix to count from.`,
      );
      return undefined;
    }
    // Releases are walked in order: a pin is a release or two behind on its minor, so a few reads at most.
    let listedLast = true;
    for (const release of await k3sAfter(target.list)) {
      const read = await k3sRelease(release);
      if (!read) {
        unpublished.add(release);
        continue;
      }
      const reference = read.images.find((image) => sameRepository(image, target.image ?? ''));
      listedLast = reference !== undefined;
      // The same image as the pin's is no fix, whatever the advisory database says of it today.
      if (!reference || sameImage(reference, target.image ?? '')) continue;
      const image = await scanned(reference, false);
      const published = time(read.published);
      if (!image.has.has(has(finding.package, finding.advisory)) && !Number.isNaN(published))
        return { at: published, release };
    }
    if (!listedLast) dropped.add(repositoryOf(target.image ?? ''));
    return undefined;
  };
  const unpublished = new Set<string>();
  const dropped = new Set<string>();
  /** An image scanned once: what it has, and when it was made, where the day is wanted. */
  const scanned = (reference: string, dated: boolean) => {
    let once = newest.get(reference);
    if (!once) {
      lines.images++;
      once = sources.image(reference).then((report) => found(report));
      newest.set(reference, once);
    }
    return dated
      ? once.then((image) => {
          if (image.created === undefined && !undated.has(reference)) {
            undated.add(reference);
            log(`::warning::${reference} gives no time it was made: its fixes have no day to count from.`);
          }
          return image;
        })
      : once;
  };
  const found = (report: TrivyReport) => {
    let created: number | undefined = time(report.Metadata?.ImageConfig?.created);
    // A reproducible build (distroless's) says it was made in 1970: it gives no day to count from.
    if (Number.isNaN(created) || created < EARLIEST) created = undefined;
    const set = new Set<string>();
    for (const result of report.Results ?? [])
      for (const v of result.Vulnerabilities ?? [])
        if (v.PkgName && v.VulnerabilityID) set.add(has(v.PkgName, v.VulnerabilityID));
    return { created, has: set };
  };
  const undated = new Set<string>();
  const digests = new Map<string, Promise<string>>();
  const digestOf = (reference: string) => {
    let once = digests.get(reference);
    if (!once) {
      once = sources.digest(reference);
      digests.set(reference, once);
    }
    return once;
  };
  // Charts: each chart's versions once, each version rendered once.
  const chartVersions = new Map<string, Promise<{ version: string; created: string }[]>>();
  const renders = new Map<string, Promise<string[] | undefined>>();
  const rendered = (chart: Chart) => {
    const key = JSON.stringify([chart.repo, chart.chart, chart.version, chart.values]);
    let once = renders.get(key);
    if (!once) {
      lines.charts++;
      once = sources.render(chart, kubeVersion).then(
        (text) => imagesIn(text),
        (error: unknown) => {
          log(
            `::warning::${chart.chart} ${chart.version} does not render with our values: passed over (${firstLine(error)}).`,
          );
          return undefined;
        },
      );
      renders.set(key, once);
    }
    return once;
  };
  /**
   * The newest chart on the pinned major whose rendering runs a copy of the image without the finding, or the first
   * later major's newest that does, marked a major; dated from the chart's publication.
   */
  const chartFix = async (target: ReadTarget, finding: Finding) => {
    const chart = target.chart;
    if (!chart) return undefined;
    const key = JSON.stringify([chart.repo, chart.chart]);
    let listed = chartVersions.get(key);
    if (!listed) {
      listed = sources.chartVersions(chart.repo, chart.chart);
      chartVersions.set(key, listed);
    }
    const versions = (await listed).filter(
      (each) => /^\d+\.\d+\.\d+$/.test(each.version) && compareVersions(each.version, chart.version) > 0,
    );
    const majorOf = (version: string) => Number(version.split('.')[0]);
    const pinnedMajor = majorOf(chart.version);
    // Each major from the pinned one, in order; within it, its versions newest first, a few at most: the newest clean
    // one on the earliest major that has one.
    const byMajor = new Map<number, { version: string; created: string }[]>();
    for (const each of versions) {
      const major = majorOf(each.version);
      if (major < pinnedMajor || major > pinnedMajor + CHART_MAJORS) continue;
      byMajor.set(major, [...(byMajor.get(major) ?? []), each]);
    }
    for (const major of [...byMajor.keys()].sort((a, b) => a - b)) {
      const newestFirst = (byMajor.get(major) ?? [])
        .sort((a, b) => compareVersions(b.version, a.version))
        .slice(0, CANDIDATES);
      for (const candidate of newestFirst) {
        const images = await rendered({ ...chart, version: candidate.version });
        const reference = images?.find((image) => sameRepository(image, target.image ?? ''));
        // A chart that no longer runs the image is not taken for a fix: the image may only have moved registry.
        if (!reference || sameImage(reference, target.image ?? '')) continue;
        const image = await scanned(reference, false);
        const created = time(candidate.created);
        if (!image.has.has(has(finding.package, finding.advisory)) && !Number.isNaN(created))
          return {
            at: created,
            target: {
              kind: 'chart',
              chart: chart.chart,
              version: candidate.version,
              major: major > pinnedMajor,
            } as Target,
          };
      }
    }
    return undefined;
  };
  /** The newest release of a tool in mise.toml's range for it whose build lacks the finding, and its day. */
  const toolReleases = new Map<string, Promise<{ version: string; published: string }[]>>();
  const toolScans = new Map<string, Promise<Set<string> | undefined>>();
  const toolFix = async (tool: string, finding: Finding) => {
    const locked = tools.get(tool);
    if (!locked) return undefined;
    let listed = toolReleases.get(tool);
    if (!listed) {
      listed = sources.toolReleases(tool);
      toolReleases.set(tool, listed);
    }
    // Within mise.toml's range for it (`pnpm = "12"`, `kubectl = "1.37"`), as `mise upgrade` moves it; the locked
    // major where mise.toml gives none.
    const range = miseRange(sources.file('mise.toml'), tool) ?? locked.split('.')[0] ?? '';
    // Newest first, a few at most: the newest release in the range whose download lacks the finding.
    const candidates = (await listed)
      .filter(
        (each) =>
          (each.version === range || each.version.startsWith(`${range}.`)) && compareVersions(each.version, locked) > 0,
      )
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, CANDIDATES);
    for (const candidate of candidates) {
      const key = `${tool}@${candidate.version}`;
      let once = toolScans.get(key);
      if (!once) {
        lines.tools++;
        once = sources.tool(tool, candidate.version).then((report) => (report ? found(report).has : undefined));
        toolScans.set(key, once);
      }
      const set = await once;
      const published = time(candidate.published);
      if (set && !set.has(has(finding.package, finding.advisory)) && !Number.isNaN(published))
        return { at: published, target: { kind: 'tool', tool, version: candidate.version } as Target };
    }
    return undefined;
  };
  // The repository's lockfiles, read once: whether one resolves a package at a version.
  const lockfiles = targets
    .filter((target) => target.kind === 'lockfile')
    .map((target) => sources.file(target.file) ?? '');
  const resolves = (name: string, version: string) => {
    const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entry = new RegExp(`^  '?${literal(name)}@${literal(version)}['(:]`, 'm');
    return lockfiles.some((lockfile) => entry.test(lockfile));
  };
  const published = async (name: string, version: string) => {
    const key = `${name}@${version}`;
    let once = npm.get(key);
    if (!once) {
      once = sources.published(name, version);
      npm.set(key, once);
      lines.npm++;
    }
    return time(await once);
  };
  /** Where moving a result writes, and what it pins now (moves.ts). */
  const whereOf = (finding: Finding, target: ReadTarget | undefined, route: Route, tool?: string): Where => {
    const own = { file: finding.file, line: finding.line };
    if (!target)
      return { kind: 'third-party', name: finding.listed ?? finding.item, pin: own, from: finding.installed };
    if (route === 'npm') return { kind: 'lockfile', name: finding.package, pin: own, from: finding.installed };
    const stage = target.kind === 'ours' ? stageOf(target) : undefined;
    const stagePin = stage ? { file: stage.dockerfile, line: stage.line } : own;
    if (route === 'tool' && tool) {
      const lock = sources.file('mise.lock') ?? '';
      const header = lock
        .split('\n')
        .findIndex((line) => [`[[tools.${tool}]]`, `[[tools."${tool}"]]`].includes(line.trim()));
      return {
        kind: target.kind,
        name: tool,
        pin: { file: 'mise.lock', line: header + 2 },
        from: tools.get(tool) ?? '',
      };
    }
    if (target.kind === 'ours' && stage)
      return { kind: 'dockerfile', name: repositoryOf(stage.image), pin: stagePin, from: pinned(stage.image) };
    if (target.kind === 'k3s' || target.kind === 'k3s-release')
      return {
        kind: target.kind,
        name: 'k3s',
        pin: own,
        from:
          (target.list
            ? k3sReleaseOf(target.list)
            : nameAndTag(target.image ?? '').tag?.replace(/-(k3s\d+)$/, '+$1')) ?? '',
      };
    if (target.kind === 'chart' && target.chart) {
      const chartName = finding.listed ?? target.chart.release;
      if (target.pin)
        return {
          kind: 'chart',
          name: `${chartName}: ${repositoryOf(target.image ?? '')}`,
          pin: target.pin,
          from: pinned(target.image ?? ''),
        };
      return { kind: 'chart', name: chartName, pin: own, from: target.chart.version };
    }
    return { kind: target.kind, name: repositoryOf(target.image ?? ''), pin: own, from: pinned(target.image ?? '') };
  };
  await pool(
    findings.map((finding, index) => async () => {
      const target = kinds.get(finding.item);
      const stage = target?.kind === 'ours' ? stageOf(target) : undefined;
      const fromBase =
        stage !== undefined &&
        (byImage.get(identity(stage.image))?.has(has(finding.package, finding.advisory)) ?? false);
      const inLockfile =
        target?.kind === 'ours' && finding.installed.split(', ').every((version) => resolves(finding.package, version));
      const tool =
        target?.kind === 'ours' && !fromBase && !inLockfile ? toolOf(finding.path, [...tools.keys()]) : undefined;
      const route = target ? routeOf(finding, target.kind, fromBase, inLockfile, tool !== undefined) : 'none';
      places[index] = whereOf(finding, target, route, tool);
      if (!target || !finding.fixed || route === 'none') return;
      if (route === 'npm') {
        // Every copy of the package must be fixable: the clock runs from the last of their fixes.
        const versions = finding.installed.split(', ').filter(Boolean);
        const times: number[] = [];
        const fixed: string[] = [];
        for (const installed of versions) {
          const version = firstFixed(installed, finding.fixed);
          const when = version ? await published(finding.package, version) : Number.NaN;
          if (!version || Number.isNaN(when)) return;
          times.push(when);
          if (!fixed.includes(version)) fixed.push(version);
        }
        if (times.length) {
          at[index] = Math.max(...times) + minimumReleaseAge * 60_000;
          fixes[index] = { kind: 'version', versions: fixed.sort(compareVersions) };
        }
        return;
      }
      if (route === 'node') {
        releases ??= sources.releases();
        const all = await releases;
        // A patched release on the installed major: moving to another major is not the fix.
        const major = finding.installed.split('.')[0];
        const patched = all
          .filter(
            (release) =>
              release.version.replace(/^v/, '').split('.')[0] === major &&
              compareVersions(release.version, finding.installed) > 0 &&
              satisfies(release.version, finding.fixed ?? ''),
          )
          .map((release) => ({ version: release.version.replace(/^v/, ''), at: time(`${release.date}T00:00:00Z`) }))
          .filter((each) => !Number.isNaN(each.at))
          .sort((a, b) => a.at - b.at || compareVersions(a.version, b.version));
        const first = patched[0];
        if (first) {
          at[index] = first.at;
          fixes[index] = { kind: 'version', versions: [first.version] };
        }
        return;
      }
      if (route === 'tool' && tool) {
        const fixed = await toolFix(tool, finding);
        if (fixed) {
          at[index] = fixed.at;
          fixes[index] = fixed.target;
        }
        return;
      }
      // An image that arrives only with a k3s release: from the first release after the pin that ships it fixed.
      if (target.kind === 'k3s-release') {
        const fixed = await k3sFix(target, finding);
        lines.k3s[fixed === undefined ? 'none' : 'fixed']++;
        if (fixed !== undefined) {
          at[index] = fixed.at;
          fixes[index] = { kind: 'k3s', release: fixed.release };
        }
        return;
      }
      // A chart's image no values file pins: the chart moves, not the image.
      if (target.kind === 'chart' && !target.pin) {
        const fixed = await chartFix(target, finding);
        if (fixed) {
          at[index] = fixed.at;
          fixes[index] = fixed.target;
        }
        return;
      }
      const latest = await newestOf(pinOf(target) ?? '', listTags);
      if (!latest) return;
      const image = await scanned(latest.reference, true);
      if (image.created === undefined) return;
      if (!image.has.has(has(finding.package, finding.advisory))) {
        at[index] = image.created;
        fixes[index] =
          target.kind === 'k3s'
            ? { kind: 'k3s', release: latest.tag.replace(/-(k3s\d+)$/, '+$1') }
            : { kind: 'image', tag: latest.tag, digest: await digestOf(latest.reference) };
        return;
      }
      // A tag that is not a version, whose image nobody has made for half a year: a line no longer built.
      if (!latest.version && now - image.created > UNBUILT_DAYS * DAY) {
        lines.unbuilt++;
        fixes[index] = { kind: 'unbuilt', built: image.created };
      }
    }),
  );
  for (const repository of dropped)
    log(
      `::warning::The last k3s release read after the pin no longer lists ${repository}: its findings have no fix to count from.`,
    );
  for (const release of unpublished)
    log(
      `::warning::k3s ${release} has a node image and no published, stable release with its list of images: passed over.`,
    );
  return { at, fixes, places, looked: lines };
}

/**
 * When each result was first seen, from the alerts: its own alert's creation, carried back across any alert of the
 * same place a re-pin split; or, for an item new to the list, the creation of an alert of the same package and advisory
 * whose item is no longer on it, open still or closed by this run's upload (closed at or after `started`, when the scan
 * began); or now.
 */
export function seen(findings: Finding[], targets: ReadTarget[], alerts: Alert[], now: number, started: number) {
  if (Number.isNaN(started)) throw new Error('the scan gave no time it started');
  const today = Math.floor(now / DAY) * DAY;
  const onList = new Set(targets.map((target) => itemKey({ file: target.file, repository: itemOf(target.label) })));
  // Each place's alerts: the earliest open or dismissed, and those closed as fixed, newest first.
  const live = new Map<string, { at: number; item: string }>();
  const closed = new Map<string, { created: number; fixed: number }[]>();
  for (const alert of alerts) {
    const place = alertPlace(alert);
    const at = time(alert.created_at);
    if (!place || Number.isNaN(at)) continue;
    const key = placeKey(place);
    if (alert.state === 'fixed') {
      const fixed = time(alert.fixed_at ?? alert.updated_at);
      if (Number.isNaN(fixed)) continue;
      const list = closed.get(key);
      if (list) list.push({ created: at, fixed });
      else closed.set(key, [{ created: at, fixed }]);
    } else if (at < (live.get(key)?.at ?? Number.POSITIVE_INFINITY)) live.set(key, { at, item: itemKey(place) });
  }
  for (const list of closed.values()) list.sort((a, b) => b.created - a.created);
  /**
   * A place's first day: its open alert's, carried back across each alert of the same place code scanning closed in
   * the upload that opened the next (a re-pin it split: closed within SPLIT of the next one's making),
   * never across a real fix, which closed one upload and left the place clear until the finding came back.
   */
  const first = new Map<string, number>();
  for (const [key, { at }] of live) {
    let day = at;
    for (const alert of closed.get(key) ?? [])
      if (alert.created < day && Math.abs(day - alert.fixed) <= SPLIT) day = alert.created;
    first.set(key, day);
  }
  // The items on the list before today: those with an alert, carried back as above, made before it.
  const itemsBefore = new Set<string>();
  for (const [key, { item }] of live) if ((first.get(key) ?? now) < today) itemsBefore.add(item);
  // Alerts of items no longer on the list, by package and advisory: open still, or closed by this run's upload.
  const gone = new Map<string, number>();
  for (const alert of alerts) {
    const place = alertPlace(alert);
    const at = time(alert.created_at);
    if (!place || Number.isNaN(at) || onList.has(itemKey(place))) continue;
    if (alert.state === 'fixed' && !(time(alert.fixed_at ?? alert.updated_at) >= started)) continue;
    const key = renameKey(place);
    gone.set(key, Math.min(gone.get(key) ?? at, at));
  }
  return findings.map((finding) => {
    const place = placeOf(finding);
    const own = first.get(placeKey(place));
    if (own !== undefined && own < today) return { seen: own, firstSeenToday: false };
    const renamed = itemsBefore.has(itemKey(place)) ? undefined : gone.get(renameKey(place));
    if (renamed !== undefined) return { seen: renamed, firstSeenToday: false };
    return { seen: own ?? now, firstSeenToday: true };
  });
}

/**
 * The fix each result's own alert states (fixes.ts), from its open or dismissed alert's message, which code scanning
 * keeps as the last upload wrote it, a dismissed alert's too. A message that does not parse states none, and is counted.
 */
function stated(findings: Finding[], alerts: Alert[], log: (line: string) => void = () => {}) {
  const byPlace = new Map<string, Fix>();
  let unread = 0;
  for (const alert of alerts) {
    if (alert.state === 'fixed') continue;
    const place = alertPlace(alert);
    if (!place) continue;
    let fix: Fix | undefined;
    try {
      fix = readFix(alert.most_recent_instance?.message?.text ?? '');
    } catch {
      unread++;
    }
    if (!fix) continue;
    const key = placeKey(place);
    const seenFix = byPlace.get(key);
    if (!seenFix || fix.day < seenFix.day) byPlace.set(key, fix);
  }
  if (unread) log(`::warning::${unread} alerts end with a fix the grammar does not read: their day is read afresh.`);
  return findings.map((finding) => byPlace.get(placeKey(placeOf(finding))));
}

/**
 * Each result's fix: its target, and the earlier of the day the sources give and the day its alert states, so the day
 * never moves forward. Where this run finds no fix installable but the alert states one, that fix stands: once a fix
 * could be installed, the deadline it started stands, and the next message keeps its day. A fix not yet installable
 * (inside pnpm's wait) with none stated is none yet. A line no longer built is first seen on the first run that found
 * it so. A fix the grammar cannot write (fixes.ts) is none.
 */
function fixesOf(
  at: (number | undefined)[],
  targets: (Target | undefined)[],
  states: (Fix | undefined)[],
  now: number,
): (Fix | undefined)[] {
  return targets.map((target, index) => {
    const state = states[index];
    const kept = state && state.target.kind !== 'unbuilt' && state.day <= now ? state : undefined;
    let fix: Fix | undefined;
    if (!target) fix = kept;
    else if (target.kind === 'unbuilt')
      fix = { target, day: state?.target.kind === 'unbuilt' ? Math.min(state.day, now) : now };
    else {
      const day = at[index];
      if (day === undefined || day > now) fix = kept;
      else fix = { target, day: kept ? Math.min(day, kept.day) : day };
    }
    // A fix the grammar cannot write is none: it would end no message the next run could read.
    return fix && writable(fix) ? fix : undefined;
  });
}

/** Each result's row: its severity, its clock and its deadline, against the time given. */
export function rows(
  findings: Finding[],
  excepted: Set<string>,
  fixes: (number | undefined)[],
  seens: { seen: number; firstSeenToday: boolean }[],
  now: number,
): Row[] {
  return findings.map((finding, index) => {
    const severity = severityOf(finding);
    const isExcepted = excepted.has(alertKey(finding));
    const fix = fixes[index];
    const { seen: first, firstSeenToday } = seens[index] ?? { seen: now, firstSeenToday: true };
    // A fix not yet installable (still inside pnpm's wait) starts no clock.
    if (isExcepted || fix === undefined || fix > now)
      return { finding, severity, excepted: isExcepted, installable: fix, seen: first, firstSeenToday, bucket: 'none' };
    const due = Math.max(fix, first) + DAYS[severity] * DAY;
    const left = due - now;
    const bucket: Bucket = left <= 0 ? 'overdue' : left <= DAY ? 'day' : left <= 7 * DAY ? 'week' : 'later';
    return { finding, severity, excepted: false, installable: fix, seen: first, firstSeenToday, due, bucket };
  });
}

const BUCKETS: [Bucket, string][] = [
  ['overdue', 'overdue'],
  ['day', 'due within a day'],
  ['week', 'within a week'],
  ['later', 'later'],
  ['none', 'no fix'],
];

/** The run's verdict, in counts alone: what fails it, and whether it passes; with the moves, which hold each reason. */
export function verdict(all: Row[], prove = false, moves: Move[] = []) {
  const open = all.filter((row) => !row.excepted);
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, open.filter((row) => row.severity === s).length]));
  const byBucket = Object.fromEntries(
    BUCKETS.map(([b]) => [b, open.filter((row) => row.bucket === b).length]),
  ) as Record<Bucket, number>;
  // A new High or Critical fails the run only with a fix to install: a red run always means a move not yet made.
  const newHigh = open.filter((row) => row.firstSeenToday && (row.severity === 'CRITICAL' || row.severity === 'HIGH'));
  const fresh = newHigh.filter((row) => row.bucket !== 'none').length;
  const waiting = newHigh.length - fresh;
  const failing = fresh + byBucket.overdue + byBucket.day;
  const lines = [
    `Deadlines: ${open.length} open results, ${all.length - open.length} excepted. By severity: ${SEVERITIES.map((s) => `${s.toLowerCase()} ${bySeverity[s]}`).join(', ')}.`,
    `By deadline: ${BUCKETS.map(([b, name]) => `${name} ${byBucket[b]}`).join(', ')}.`,
    `New high or critical (first seen today): ${fresh} with a fix to install, ${waiting} with none the scan can date, which fail nothing.`,
    failing
      ? prove
        ? `The real run would fail on ${fresh} new high or critical with a fix, ${byBucket.day} due within a day and ${byBucket.overdue} past their deadline; a proving run fails on none.`
        : `The run fails: ${fresh} new high or critical with a fix, ${byBucket.day} due within a day, ${byBucket.overdue} past their deadline.`
      : 'Nothing new at high or critical has a fix to install, and nothing is due within a day or past its deadline.',
  ];
  // Each reason with the moves that hold it, by name (a lockfile's by its file alone), as the run's last lines.
  const byResult = new Map<string, Move>();
  for (const move of moves) for (const each of move.results) byResult.set(each, move);
  const holding = (test: (row: Row) => boolean) => {
    const names = new Set<string>();
    for (const row of open.filter(test)) {
      const move = byResult.get(fingerprint(row.finding));
      if (move) names.add(`${publicMove(move).name}${move.lockfile ? '' : ` ${move.from}`}`);
    }
    return [...names];
  };
  if (failing) {
    const reasons: [string, (row: Row) => boolean][] = [
      [
        'New high or critical with a fix',
        (row) =>
          row.firstSeenToday && row.bucket !== 'none' && (row.severity === 'CRITICAL' || row.severity === 'HIGH'),
      ],
      ['Due within a day', (row) => row.bucket === 'day'],
      ['Past its deadline', (row) => row.bucket === 'overdue'],
    ];
    for (const [reason, test] of reasons) {
      const count = open.filter(test).length;
      if (!count) continue;
      const names = holding(test);
      lines.push(`${reason}: ${count}, held by ${names.length ? names.join('; ') : 'no move the scan could make'}.`);
    }
  }
  const counts: DayCounts = {
    noFix: byBucket.none,
    excepted: all.length - open.length,
    overdue: byBucket.overdue,
    dueWithinDay: byBucket.day,
    newHighWithFix: fresh,
    newHighWithoutFix: waiting,
  };
  return { lines, bySeverity, byBucket, fresh, waiting, counts, passes: prove || failing === 0 };
}

/** The whole judgement of a scan's hand-off, against the time given: each result's row, its fix and its move. */
export async function assess(handoff: Handoff, sources: Sources, now: number, log: (line: string) => void = () => {}) {
  const findings = handoff.findings;
  const [found, alerts] = await Promise.all([
    installable(
      findings,
      handoff.targets,
      sources,
      handoff.minimumReleaseAge ?? PNPM_DEFAULT_MINUTES,
      log,
      now,
      handoff.kubeVersion,
    ),
    sources.alerts(),
  ]);
  const ours = alerts.filter(isOurs);
  const fixes = fixesOf(found.at, found.fixes, stated(findings, ours, log), now);
  // A fix's day where it has one; a fix still inside pnpm's wait keeps its time, so its row starts no clock yet.
  const installableAt = fixes.map((fix, index) =>
    fix && fix.target.kind !== 'unbuilt' ? fix.day : (found.at[index] ?? 0) > now ? found.at[index] : undefined,
  );
  const judgedRows = rows(
    findings,
    new Set(handoff.excepted),
    installableAt,
    seen(findings, handoff.targets, ours, now, time(handoff.started)),
    now,
  );
  const judged: Judged[] = judgedRows.map((row, index) => {
    const where = found.places[index] ?? {
      kind: 'third-party' as Kind,
      name: row.finding.item,
      pin: { file: row.finding.file, line: row.finding.line },
      from: row.finding.installed,
    };
    return {
      finding: { ...row.finding, fix: fixes[index] },
      severity: row.severity,
      excepted: row.excepted,
      due: row.due,
      firstSeenToday: row.firstSeenToday,
      ...where,
    };
  });
  return { rows: judgedRows, fixes, judged, looked: found.looked };
}

/** Runs each task, a few at a time; the first failure is thrown once all have settled. */
async function pool(tasks: (() => Promise<void>)[], size = 8) {
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        await task?.();
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  if (failed) throw failed;
}

/** A package's document in npm's registry: its whole name encoded, the scope's `@` kept, as the registry writes it. */
export const npmUrl = (name: string) => `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, '@')}`;

/** A repository as skopeo names it: Docker Hub's official images under docker.io/library/. */
export function skopeoName(repository: string) {
  if (hasRegistry(repository)) return `docker://${repository}`;
  return `docker://docker.io/${repository.includes('/') ? '' : 'library/'}${repository}`;
}

/** The sources as the workflow has them: npm, Node's index, skopeo, Trivy on the scan's database, the API. */
function realSources(handoff: Handoff, checkout: string, trivyImage: string, work: string, token?: string): Sources {
  const tools = realTools(trivyImage, handoff.cache, work);
  // Read once, outside any retry: a record that cannot be read fails the run with its own cause.
  const apiVersions = apiVersionsOf(checkout);
  const times = new Map<string, Promise<Record<string, string>>>();
  // One HTTP read: the answer's status and text, or an error that names the source, never the package asked for (the
  // log gives counts alone), and is permanent for an answer trying again cannot change.
  const request = async (url: string, source: string, init: RequestInit = {}) => {
    const named = (error: unknown) => new Error(`${source}: ${reason(error)}`);
    const response = await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(120_000) }).catch(
      (error: unknown) => {
        throw named(error);
      },
    );
    if (response.status !== 404 && !response.ok) throw answered(source, response.status);
    const text = await response.text().catch((error: unknown) => {
      throw named(error);
    });
    return { status: response.status, text };
  };
  const json = (text: string, source: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${source} gave an answer that is not JSON`);
    }
  };
  // A package Trivy read is one npm has: a 404 is a source not read, not a package with no fix.
  const get = async (url: string, source: string) => {
    const { status, text } = await request(url, source);
    if (status === 404) throw new Permanent(`${source} answered 404`);
    return json(text, source);
  };
  return {
    async published(name, version) {
      let once = times.get(name);
      if (!once) {
        once = transient(async () => {
          const body = (await get(npmUrl(name), "npm's registry")) as { time?: Record<string, string> } | undefined;
          if (!body?.time || typeof body.time !== 'object') throw new Error("npm's registry gave no publish times");
          return body.time;
        });
        times.set(name, once);
      }
      return (await once)[version];
    },
    async releases() {
      const body = await transient(() => get(NODE_INDEX, "Node's release index"));
      if (!Array.isArray(body)) throw new Error("Node's release index is not a list");
      return body as { version: string; date: string }[];
    },
    async tags(repository) {
      const { stdout } = await tools.retry(() =>
        run('skopeo', ['list-tags', skopeoName(repository)], { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 }),
      );
      const listed = (JSON.parse(stdout) as { Tags?: unknown }).Tags;
      if (!Array.isArray(listed) || !listed.every((tag) => typeof tag === 'string'))
        throw new Error(`skopeo gave no list of tags for ${repository}`);
      return listed as string[];
    },
    async k3s(release) {
      const tag = encodeURIComponent(release);
      const source = `k3s's release ${release}`;
      const listed = await transient(() =>
        request(`https://github.com/k3s-io/k3s/releases/download/${tag}/k3s-images.txt`, source),
      );
      // A tag whose release is not published yet: nothing to install.
      if (listed.status === 404) return undefined;
      const list = listed.text;
      const answer = await transient(() =>
        request(`https://api.github.com/repos/k3s-io/k3s/releases/tags/${tag}`, source, {
          headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        }),
      );
      const about = (answer.status === 404 ? {} : json(answer.text, source)) as {
        published_at?: unknown;
        prerelease?: unknown;
        draft?: unknown;
      };
      // A draft, or a release not yet published: nothing to install.
      if (typeof about.published_at !== 'string' || about.prerelease === true || about.draft === true) return undefined;
      const images = list
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
      if (!images.length) throw new Error(`k3s's release ${release} lists no images`);
      return { published: about.published_at, images };
    },
    image: (reference) =>
      tools.retry(() => tools.trivy(['image', '--scanners', 'vuln', '--image-src', 'remote', '--', reference])),
    async digest(reference) {
      // The tag's index, as scripts/ci-images.sh's `current` reads it: the SHA-256 of the raw manifest skopeo gives.
      const { stdout } = await tools.retry(() =>
        run('skopeo', ['inspect', '--raw', '--no-creds', skopeoName(reference)], {
          encoding: 'buffer',
          maxBuffer: 16 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
        }),
      );
      return `sha256:${createHash('sha256').update(stdout).digest('hex')}`;
    },
    async manifests(reference) {
      // The raw manifest, as the registry gives it to a pull: an index lists each platform's manifest by digest. With the
      // job's registry credentials, so an image of ours in GHCR is read as it is pulled.
      const { stdout } = await tools.retry(() =>
        run('skopeo', ['inspect', '--raw', skopeoName(byDigest(reference))], {
          encoding: 'buffer',
          maxBuffer: 16 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
        }),
      );
      return manifestDigests(stdout);
    },
    async chartVersions(repo, chart) {
      const source = `the chart repository ${repo}`;
      if (!/^https:\/\/[\w.-]+(\/[\w.~-]+)*\/?$/.test(repo))
        throw new Permanent(`${source} is not an HTTPS repository`);
      const { status, text } = await transient(() => request(`${repo.replace(/\/$/, '')}/index.yaml`, source));
      if (status === 404) throw new Permanent(`${source} answered 404`);
      // The index read through yq, as the list reads YAML: each version of the chart with when it was published.
      const file = join(work, `index-${createHash('sha256').update(repo).digest('hex').slice(0, 12)}.yaml`);
      writeFileSync(file, text);
      const read = await run(
        'yq',
        [
          'eval',
          '--output-format=json',
          '--indent=0',
          '[.entries[strenv(CHART)][] | {"version": .version, "created": .created}]',
          file,
        ],
        { env: { ...process.env, CHART: chart }, maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60 * 1000 },
      );
      const versions = JSON.parse(read.stdout) as unknown;
      if (!Array.isArray(versions)) throw new Error(`${source} gave no versions of ${chart}`);
      return versions.filter(
        (each): each is { version: string; created: string } =>
          typeof each?.version === 'string' && typeof each?.created === 'string',
      );
    },
    render: (chart, kubeVersion) => tools.retry(() => tools.render(chart, checkout, kubeVersion, apiVersions)),
    async toolReleases(tool) {
      const repository = aquaRepository(readLock(checkout), tool);
      if (!repository) throw new Permanent(`mise.lock names no repository for ${tool}`);
      const source = `${tool}'s releases`;
      const answer = await transient(() =>
        request(`https://api.github.com/repos/${repository}/releases?per_page=100`, source, {
          headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        }),
      );
      const body = json(answer.text, source);
      if (!Array.isArray(body)) throw new Error(`${source} is not a list`);
      return (body as { tag_name?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown }[]).flatMap(
        (release) =>
          typeof release.tag_name === 'string' &&
          typeof release.published_at === 'string' &&
          release.draft !== true &&
          release.prerelease !== true
            ? [{ version: release.tag_name.replace(/^v/, ''), published: release.published_at }]
            : [],
      );
    },
    async tool(tool, version) {
      const url = toolUrl(readLock(checkout), tool, version);
      if (!url) return undefined;
      const { status, bytes } = await transient(async () => {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
        if (response.status !== 404 && !response.ok) throw answered(`${tool} ${version}'s download`, response.status);
        return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
      });
      if (status === 404) return undefined;
      // Unpacked where Trivy reads it, as its own files: nothing in it runs.
      const dir = mkdtempSync(join(work, `${tool}-`));
      writeFileSync(join(dir, 'release.tar.gz'), bytes);
      await run('tar', [
        '--extract',
        '--gzip',
        '--no-same-owner',
        '--file',
        join(dir, 'release.tar.gz'),
        '--directory',
        dir,
      ]);
      return tools.retry(() => tools.trivy(['rootfs', '--scanners', 'vuln', '/src'], dir));
    },
    file(path) {
      const full = resolve(checkout, path);
      return full.startsWith(`${resolve(checkout)}/`) && existsSync(full) ? readFileSync(full, 'utf-8') : undefined;
    },
    async alerts() {
      if (!token) throw new Error('no token to read code scanning with');
      // Each page tried again, as a pull is: a run reads several hundred, and one dropped connection is no answer.
      const direct = realApi(token);
      const api = {
        ...direct,
        get: (path: string) =>
          transient(() =>
            direct.get(path).catch((error: unknown) => {
              // realApi names the status after the path: `GET /repos/…: 403 …`.
              const status = Number(/: (\d{3}) /.exec(error instanceof Error ? error.message : '')?.[1]);
              throw status ? answered('code scanning', status) : new Error(`code scanning: ${reason(error)}`);
            }),
          ),
      };
      const repository = handoff.repository;
      const [open, dismissed] = await Promise.all([
        alertsIn(api, repository, 'open'),
        alertsIn(api, repository, 'dismissed'),
      ]);
      // Those closed as fixed since the oldest alert still open was made, the most recently updated first: an alert a
      // re-pin split closed when the next opened, so nothing older can give an open alert its day; a rename's, closed
      // by this run, is among them.
      const oldest = Math.min(
        time(handoff.started),
        ...[...open, ...dismissed].map((alert) => time(alert.created_at)).filter((n) => !Number.isNaN(n)),
      );
      const fixed = await alertsIn(api, repository, 'fixed', {
        query: '&sort=updated&direction=desc',
        while: (alert) => !(time(alert.updated_at ?? alert.fixed_at) < oldest - SPLIT),
      });
      return [...open, ...dismissed, ...fixed];
    },
  };
}

/** A reference skopeo reads: one pinned by tag and digest is read by its digest alone, which skopeo requires. */
export function byDigest(reference: string) {
  const { repository, digest } = splitReference(reference);
  return digest ? `${repository}@${digest}` : reference;
}

/** A raw manifest's digest, and the digests of the platform manifests it lists when it is an index. */
export function manifestDigests(raw: Buffer) {
  const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new Error('a registry gave a manifest that is not JSON');
  }
  const listed = (body as { manifests?: unknown }).manifests;
  const platforms = (Array.isArray(listed) ? listed : [])
    .map((each) => (each as { digest?: unknown }).digest)
    .filter((each): each is string => typeof each === 'string' && DIGEST.test(each));
  return { digest, platforms: [...new Set(platforms)].sort() };
}

/** Every image target the scan read, with its digests and its pin, for `moves.json`'s `scanned`. */
export async function scannedImages(
  targets: ReadTarget[],
  sources: Pick<Sources, 'manifests'>,
): Promise<ScannedImage[]> {
  const read = new Map<string, Promise<{ digest: string; platforms: string[] }>>();
  const out: ScannedImage[] = [];
  await pool(
    targets
      .filter((target) => target.image)
      .map((target) => async () => {
        const image = target.image ?? '';
        let once = read.get(image);
        if (!once) {
          once = sources.manifests(image);
          read.set(image, once);
        }
        const { digest, platforms } = await once;
        const pinned = splitReference(image).digest;
        out.push({
          kind: target.kind,
          item: target.name ?? target.label,
          image,
          digests: [...new Set([digest, ...(pinned ? [pinned] : []), ...platforms])],
          pin: target.pin ?? { file: target.file, line: target.line ?? 1 },
        });
      }),
  );
  return out;
}

/** The scanned checkout's mise.lock. */
const readLock = (checkout: string) => {
  const file = join(checkout, 'mise.lock');
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
};

/** A tool's section of mise.lock: from its header to the next tool's. */
const lockSection = (lock: string, tool: string) => {
  const plain = lock.indexOf(`[[tools.${tool}]]\n`);
  const start = plain >= 0 ? plain : lock.indexOf(`[[tools."${tool}"]]\n`);
  if (start < 0) return undefined;
  const next = lock.indexOf('\n[[tools.', start + 1);
  return lock.slice(start, next < 0 ? undefined : next);
};

/** The GitHub repository mise.lock's aqua backend names for a tool (`aqua:pnpm/pnpm`), or undefined. */
export function aquaRepository(lock: string, tool: string) {
  const backend = /^backend = "aqua:([\w.-]+\/[\w.-]+)"$/m.exec(lockSection(lock, tool) ?? '')?.[1];
  return backend;
}

/** A tool's download for linux-x64 at another version, from mise.lock's at the locked one, on its publisher's releases. */
export function toolUrl(lock: string, tool: string, version: string) {
  const section = lockSection(lock, tool) ?? '';
  const locked = /^version = "([^"]+)"$/m.exec(section)?.[1];
  const platform = section.indexOf('platforms.linux-x64');
  const url = platform < 0 ? undefined : /^url = "([^"]+)"$/m.exec(section.slice(platform))?.[1];
  const repository = aquaRepository(lock, tool);
  if (!locked || !url || !repository || !/^[\w.+-]+$/.test(version)) return undefined;
  if (!url.startsWith(`https://github.com/${repository}/releases/download/`) || !url.endsWith('.tar.gz'))
    return undefined;
  return url.split(locked).join(version);
}

/** An answer trying again cannot change: a 4xx but 429. */
class Permanent extends Error {}

/** Tries again on a dropped connection, a timeout, a 429 or a 5xx, as a pull is tried; a permanent answer at once. */
const transient = <T>(what: () => Promise<T>) =>
  retried(what, { waits: PULL_WAITS, permanent: (error) => error instanceof Permanent });

const answered = (source: string, status: number) =>
  status === 429 || status >= 500
    ? new Error(`${source} answered ${status}`)
    : new Permanent(`${source} answered ${status}`);

/** Why a fetch failed: its message, and the cause undici keeps beneath "fetch failed" (ECONNRESET, a TLS error). */
const reason = (error: unknown) => {
  const message = firstLine(error);
  const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  return cause ? `${message} (${cause.code ?? cause.message ?? 'no cause given'})` : message;
};

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 300);

/**
 * Each result's message ended with its fix, in the SARIF the scan wrote and in the comments its excepted alerts are
 * dismissed with (keyed by the message, sarif.ts's `alertKey`): what is uploaded is what was judged.
 */
export function rewrite(file: Sarif, excepted: Record<string, string>, findings: Finding[]) {
  const byFingerprint = new Map(findings.map((finding) => [fingerprint(finding), finding]));
  for (const run of file.runs)
    for (const result of run.results) {
      const finding = byFingerprint.get(result.partialFingerprints['vulnerabilities/v1'] ?? '');
      if (finding?.fix) result.message.text = messageOf(finding);
    }
  const keys: Record<string, string> = {};
  const byKey = new Map(
    findings.map((finding) => [alertKey({ ...finding, fix: undefined, move: undefined }), finding]),
  );
  for (const [key, comment] of Object.entries(excepted)) {
    const finding = byKey.get(key);
    keys[finding ? alertKey(finding) : key] = comment;
  }
  return { file, excepted: keys };
}

/** The verdict a scan's step after the upload fails on: written before it, read after. */
interface Saved {
  passes: boolean;
  lines: string[];
}

const USAGE =
  'Usage: GH_TOKEN=<token> deadlines.ts <scan out dir> --checkout <dir> --trivy-pin <Dockerfile> (--write | --prove) [--memo <file> [--memo-day <YYYY-MM-DD>]]\n' +
  '       deadlines.ts --verdict <scan out dir>';

export async function main(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  // After the upload: the verdict judged before it, its last lines, and the run's end.
  const after = option('--verdict');
  if (after) {
    const saved = JSON.parse(readFileSync(join(after, 'verdict.json'), 'utf-8')) as Saved;
    for (const line of saved.lines) console.log(line);
    if (!saved.passes) console.log(`::error::${saved.lines.find((line) => line.startsWith('The run fails')) ?? ''}`);
    return saved.passes ? 0 : 1;
  }
  const [dir] = args.filter(
    (arg, i) => !arg.startsWith('--') && !args[i - 1]?.match(/^--(checkout|trivy-pin|memo|memo-day)$/),
  );
  const checkout = option('--checkout');
  const pinFile = option('--trivy-pin');
  const prove = args.includes('--prove');
  const write = args.includes('--write');
  const memoFile = option('--memo');
  // The day the workflow keyed the file by, so a run that crosses midnight keeps the answers under the key it read.
  const memoDay = option('--memo-day');
  if (
    !dir ||
    !checkout ||
    !pinFile ||
    prove === write ||
    (args.includes('--memo') && !memoFile) ||
    (memoDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(memoDay))
  ) {
    console.error(USAGE);
    return 2;
  }
  const pin = trivyPin(readFileSync(pinFile, 'utf-8'));
  if (!pin?.[1]) {
    console.error(`::error::No Trivy pin in ${pinFile}`);
    return 1;
  }
  const handoff = JSON.parse(readFileSync(join(dir, 'deadlines.json'), 'utf-8')) as Handoff;
  const work = join(resolve(dir), 'deadlines');
  mkdirSync(work, { recursive: true });
  const now = Date.now();
  const real = realSources(handoff, checkout, pin[1], mkdtempSync(join(work, 'work-')), process.env.GH_TOKEN);
  const memo = memoFile ? readMemo(memoFile, memoDay ?? dayOf(now)) : undefined;
  const asked: MemoCount = { kept: 0, asked: 0 };
  // The Helm that renders a chart, from this repository's mise.lock, in the key of each rendering kept.
  const helm = memo ? (await promisify(execFile)('helm', ['version', '--short'])).stdout.trim() : '';
  const sources = memo ? memoised(real, memo, asked, helm) : real;
  let judged: Awaited<ReturnType<typeof assess>>;
  try {
    judged = await assess(handoff, sources, now, (line) => console.log(line));
  } catch (error) {
    console.error(
      `::error::The deadlines could not be read: ${firstLine(error)}. The run fails${write ? ', and nothing is uploaded' : ''}.`,
    );
    return 1;
  }
  const context: Context = {
    repository: handoff.repository,
    app: handoff.repository === APP,
    dependabot: dependabotDirectories(sources.file('.github/dependabot.yml')),
    direct: new Set(
      handoff.targets
        .filter((target) => target.kind === 'lockfile')
        .flatMap((target) => [...directPackages(sources.file(target.file))]),
    ),
    now,
  };
  const list = moves(judged.judged, context);
  // Each result in a move names its place in moves.json and the run, after its fix (fixes.ts), so the alerts tie to it.
  const run = /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : undefined;
  let scanned: ScannedImage[];
  try {
    scanned = await scannedImages(handoff.targets, sources);
  } catch (error) {
    console.error(
      `::error::The images scanned could not be listed with their digests: ${firstLine(error)}. The run fails${write ? ', and nothing is uploaded' : ''}.`,
    );
    return 1;
  }
  const { lines, bySeverity, byBucket, passes, counts } = verdict(judged.rows, prove, list);
  const file = movesFile(list, context, run, scanned, counts);
  const tags = new Map<string, MoveTag>();
  if (run)
    for (const [index, move] of list.entries())
      for (const each of move.results) tags.set(each, { index: index + 1, run });
  if (memo && memoFile) {
    writeMemo(memoFile, memo);
    console.log(
      `Lookups of registries and releases: ${asked.kept} answered from the day's (${memo.day}), ${asked.asked} asked.`,
    );
  }
  const looked = `Read the publish times of ${judged.looked.npm} npm versions, ${judged.looked.images} newer images, ${judged.looked.charts} charts' renderings and ${judged.looked.tools} tools' releases. Images k3s's release brings: ${judged.looked.k3s.fixed} results fixed by a later k3s release, ${judged.looked.k3s.none} not yet. Lines no longer built: ${judged.looked.unbuilt} results.`;
  const table = movesTable(file);
  const images = `Images scanned, each in moves.json with its digests and pin: ${file.scanned.length} (${new Set(file.scanned.map((each) => each.image)).size} references).`;
  for (const line of [looked, images, ...table, '', ...lines]) console.log(line);
  writeFileSync(join(dir, 'moves.json'), `${JSON.stringify(file, null, 2)}\n`);
  if (write) {
    // What is uploaded carries each fix: the SARIF's messages, and the excepted alerts' keys, which name them.
    const sarifPath = join(dir, 'vulnerabilities.sarif');
    const exceptionsPath = join(dir, 'exceptions.json');
    const exceptions = JSON.parse(readFileSync(exceptionsPath, 'utf-8')) as {
      repository: string;
      excepted: Record<string, string>;
    };
    const findings = judged.judged.map((each) => ({ ...each.finding, move: tags.get(fingerprint(each.finding)) }));
    const rewritten = rewrite(JSON.parse(readFileSync(sarifPath, 'utf-8')) as Sarif, exceptions.excepted, findings);
    const over = overLimits(rewritten.file);
    if (over.length) {
      console.error(
        `::error::With each fix in its message, the results are over code scanning's limits: ${over.join('; ')}. Nothing is uploaded.`,
      );
      return 1;
    }
    writeFileSync(sarifPath, JSON.stringify(rewritten.file));
    writeFileSync(exceptionsPath, JSON.stringify({ ...exceptions, excepted: rewritten.excepted }));
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ passes, lines: lines.slice(3) } satisfies Saved));
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### Deadlines',
        '',
        '| Severity | Open | Overdue | Due within a day | Within a week | Later | No fix |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...SEVERITIES.map((s) => {
          const of = judged.rows.filter((row) => !row.excepted && row.severity === s);
          return `| ${s.toLowerCase()} | ${bySeverity[s]} | ${BUCKETS.map(([b]) => of.filter((row) => row.bucket === b).length).join(' | ')} |`;
        }),
        `| all | ${Object.values(bySeverity).reduce((a, b) => a + b, 0)} | ${BUCKETS.map(([b]) => byBucket[b]).join(' | ')} |`,
        '',
        ...lines.slice(2),
        '',
        '### Moves',
        '',
        ...table,
        '',
      ].join('\n'),
    );
  // A run that writes for the upload fails after it, on the verdict it saved; a proving run fails on none.
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
