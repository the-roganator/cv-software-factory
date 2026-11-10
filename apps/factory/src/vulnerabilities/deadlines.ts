/**
 * Each open finding's deadline, worked out afresh on every run from what the scan read, the registries and code
 * scanning, with no state of its own; and the run's verdict on them.
 *
 *     node apps/factory/src/vulnerabilities/deadlines.ts <scan's out dir> --checkout <dir> --trivy-pin <Dockerfile>
 *       [--prove]
 *
 * - **Severity** is the higher of Trivy's and the publisher's (`Finding.publisher`: Trivy's `VendorSeverity` for the
 *   advisory's own source, or Node's own rating for Node's).
 * - **The fix is installable** from the first fixed version's publish time in npm's registry plus the scanned
 *   repository's `minimumReleaseAge` (pnpm's default of a day where it sets none), for an npm package of ours: a
 *   lockfile's, or one in an image of ours that a lockfile of ours resolves at that version. For Node, from the first patched release
 *   in Node's release index. For anything else in an image (an operating system's package, a binary it ships), from
 *   the creation of the newest image on the line of the pin that brings it (the runtime stage of its Dockerfile, for an
 *   image of ours), found as `scripts/ci-images.sh`'s `newest` finds it, or the tag's current image for a tag that is
 *   not a version, once that image no longer has the finding. In an image of ours, only what its runtime stage's image
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
 * - **The run fails** on a new High or Critical (first seen today), on one due within a day, and on one past its
 *   deadline, after the upload, so a new finding's alert exists. `--prove`, a proving run's, which uploads nothing,
 *   fails on none of them. A source that cannot be read (npm, Node's index, an image line's tags or its newest image,
 *   code scanning) fails either, as an unread item fails the scan.
 *
 * The log and the step summary give counts alone, never a package or an advisory: by severity, and by overdue, due
 * within a day, within a week, later, and no fix. Node runs this with no dependencies, from a sparse checkout of this
 * repository; Trivy runs in its pinned image, as the scan runs it, on the scan's database.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type Alert, alertsIn, isOurs, realApi } from './alerts.ts';
import { identity } from './inventory.ts';
import { satisfies } from './node.ts';
import { alertKey, type Finding, SEVERITIES, type Severity } from './sarif.ts';
import { type Handoff, type ReadTarget, realTools, repositoryOf, type TrivyReport, trivyPin } from './scan.ts';

const run = promisify(execFile);
const DAY = 86_400_000;

/** How long a finding has from its clock's start, in days, by its severity. */
export const DAYS: Record<Severity, number> = { CRITICAL: 2, HIGH: 7, MEDIUM: 30, LOW: 90, UNKNOWN: 90 };

/** pnpm's own `minimumReleaseAge`, in minutes, where the repository sets none. */
export const PNPM_DEFAULT_MINUTES = 24 * 60;

const NODE_INDEX = 'https://nodejs.org/dist/index.json';

/** The earliest time an image may say it was made: before it, the build set none (a reproducible one says 1970). */
const EARLIEST = Date.parse('2000-01-01T00:00:00Z');

/** Trivy's types of an npm package. */
const NPM_TYPES = new Set(['pnpm', 'npm', 'yarn', 'node-pkg']);

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
  /** A file of the scanned checkout, or undefined. */
  file(path: string): string | undefined;
  /** The scan's alerts, open and dismissed, and those fixed since the time given. */
  alerts(since: string): Promise<Alert[]>;
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

/** How a finding's fix reaches us: through npm, Node's releases, or a newer image on its pin's line. */
export function routeOf(
  finding: Pick<Finding, 'type'>,
  kind: ReadTarget['kind'],
  fromBase = false,
  inLockfile = false,
): 'npm' | 'node' | 'image' | 'none' {
  if (finding.type === 'node') return 'node';
  if (kind === 'lockfile') return 'npm';
  if (kind !== 'ours') return 'image';
  // An image of ours: what its runtime stage's image has comes with a newer one; an npm package a lockfile of ours
  // resolves, through npm; anything else its Dockerfile adds itself, which no newer base brings, has no fix to count from.
  if (fromBase) return 'image';
  return NPM_TYPES.has(finding.type) && inLockfile ? 'npm' : 'none';
}

/** A reference's name and tag, its digest left off. */
export function nameAndTag(reference: string) {
  const repository = repositoryOf(reference);
  const name = reference.split('@')[0] ?? '';
  return { repository, tag: name.length > repository.length ? name.slice(repository.length + 1) : undefined };
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

const itemOf = (label: string) => repositoryOf(label.replace(/ \(sha256:[0-9a-f]+\)$/, ''));
const placeOf = (finding: Finding): Place => ({
  advisory: finding.advisory,
  file: finding.file,
  package: finding.package,
  repository: itemOf(finding.label),
});

/** An alert's place, read from its rule and its latest message (sarif.ts's `messageOf`), or undefined. */
export function alertPlace(alert: Alert): Place | undefined {
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

const placeKey = (place: Place) => JSON.stringify([place.advisory, place.file, place.package, place.repository]);
const itemKey = (place: Pick<Place, 'file' | 'repository'>) => JSON.stringify([place.file, place.repository]);
const time = (text: string | null | undefined) => (text ? Date.parse(text) : Number.NaN);

export type Bucket = 'overdue' | 'day' | 'week' | 'later' | 'none';

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

/** When each result's fix became installable, by its index in `findings`, from the sources. */
export async function installable(
  findings: Finding[],
  targets: ReadTarget[],
  sources: Sources,
  minimumReleaseAge = PNPM_DEFAULT_MINUTES,
  log: (line: string) => void = () => {},
) {
  const kinds = new Map(targets.map((target) => [target.key, target]));
  const at: (number | undefined)[] = findings.map(() => undefined);
  const lines = { npm: 0, images: 0 };
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
  // npm: each package and version once; each repository's tags once; each line's newest once.
  const npm = new Map<string, Promise<string | undefined>>();
  const tags = new Map<string, Promise<string[]>>();
  let releases: Promise<{ version: string; date: string }[]> | undefined;
  const newest = new Map<string, Promise<{ created?: number | undefined; has: Set<string> }>>();
  const pins = new Map<string, string | undefined>();
  /** The pin whose line brings a target's image findings: its own, or its Dockerfile's runtime stage for one of ours. */
  const pinOf = (target: ReadTarget) => {
    if (pins.has(target.key)) return pins.get(target.key);
    let pin = target.image;
    if (target.kind === 'ours') {
      const dockerfile = dockerfileOf(target.image ?? '', (path) => sources.file(path) !== undefined);
      pin = dockerfile ? runtimeStage(sources.file(dockerfile) ?? '') : undefined;
      if (!pin)
        log(
          `::warning::No Dockerfile's runtime stage was found for ${repositoryOf(target.image ?? '')}: its image findings have no fix to count from.`,
        );
    }
    pins.set(target.key, pin);
    return pin;
  };
  const newestOf = async (pin: string) => {
    const { repository, tag } = nameAndTag(pin);
    if (!tag) return undefined;
    // A version's newest on its line; any other tag, the image it names now.
    if (!tagLine(tag)) return `${repository}:${tag}`;
    let listed = tags.get(repository);
    if (!listed) {
      listed = sources.tags(repository);
      tags.set(repository, listed);
    }
    return `${repository}:${newestOnLine(tag, await listed) ?? tag}`;
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
  await pool(
    findings.map((finding, index) => async () => {
      const target = kinds.get(finding.item);
      if (!target || !finding.fixed) return;
      const pin = target.kind === 'ours' ? pinOf(target) : undefined;
      const fromBase =
        pin !== undefined && (byImage.get(identity(pin))?.has(has(finding.package, finding.advisory)) ?? false);
      const route = routeOf(
        finding,
        target.kind,
        fromBase,
        target.kind === 'ours' && finding.installed.split(', ').every((version) => resolves(finding.package, version)),
      );
      if (route === 'none') return;
      if (route === 'npm') {
        // Every copy of the package must be fixable: the clock runs from the last of their fixes.
        const versions = finding.installed.split(', ').filter(Boolean);
        const times: number[] = [];
        for (const installed of versions) {
          const version = firstFixed(installed, finding.fixed);
          const when = version ? await published(finding.package, version) : Number.NaN;
          if (Number.isNaN(when)) return;
          times.push(when);
        }
        if (times.length) at[index] = Math.max(...times) + minimumReleaseAge * 60_000;
        return;
      }
      if (route === 'node') {
        releases ??= sources.releases();
        const all = await releases;
        // A patched release on the installed major: moving to another major is not the fix.
        const major = finding.installed.split('.')[0];
        const days = all
          .filter(
            (release) =>
              release.version.replace(/^v/, '').split('.')[0] === major &&
              compareVersions(release.version, finding.installed) > 0 &&
              satisfies(release.version, finding.fixed ?? ''),
          )
          .map((release) => time(`${release.date}T00:00:00Z`))
          .filter((n) => !Number.isNaN(n));
        if (days.length) at[index] = Math.min(...days);
        return;
      }
      const reference = await newestOf(pin ?? pinOf(target) ?? '');
      if (!reference) return;
      let once = newest.get(reference);
      if (!once) {
        lines.images++;
        once = sources.image(reference).then((report) => {
          let created: number | undefined = time(report.Metadata?.ImageConfig?.created);
          // A reproducible build (distroless's) says it was made in 1970: it gives no day to count from.
          if (Number.isNaN(created) || created < EARLIEST) {
            log(`::warning::${reference} gives no time it was made: its fixes have no day to count from.`);
            created = undefined;
          }
          const found = new Set<string>();
          for (const result of report.Results ?? [])
            for (const v of result.Vulnerabilities ?? [])
              if (v.PkgName && v.VulnerabilityID) found.add(has(v.PkgName, v.VulnerabilityID));
          return { created, has: found };
        });
        newest.set(reference, once);
      }
      const image = await once;
      if (image.created !== undefined && !image.has.has(has(finding.package, finding.advisory)))
        at[index] = image.created;
    }),
  );
  return { at, looked: lines };
}

/**
 * When each result was first seen, from the alerts: its own alert's creation; or, for an item new to the list, the
 * creation of an alert of the same package and advisory whose item is no longer on it; or now.
 */
export function seen(findings: Finding[], targets: ReadTarget[], alerts: Alert[], now: number) {
  const today = Math.floor(now / DAY) * DAY;
  const onList = new Set(targets.map((target) => itemKey({ file: target.file, repository: itemOf(target.label) })));
  const live = alerts.filter((alert) => alert.state === 'open' || alert.state === 'dismissed');
  const created = new Map<string, number>();
  const itemsBefore = new Set<string>();
  for (const alert of live) {
    const place = alertPlace(alert);
    const at = time(alert.created_at);
    if (!place || Number.isNaN(at)) continue;
    const key = placeKey(place);
    created.set(key, Math.min(created.get(key) ?? at, at));
    if (at < today) itemsBefore.add(itemKey(place));
  }
  // Alerts of items no longer on the list, by package and advisory: open still, or closed by this run's upload.
  const gone = new Map<string, number>();
  for (const alert of alerts) {
    const place = alertPlace(alert);
    const at = time(alert.created_at);
    if (!place || Number.isNaN(at) || onList.has(itemKey(place))) continue;
    const key = renameKey(place);
    gone.set(key, Math.min(gone.get(key) ?? at, at));
  }
  return findings.map((finding) => {
    const place = placeOf(finding);
    const own = created.get(placeKey(place));
    if (own !== undefined && own < today) return { seen: own, firstSeenToday: false };
    const renamed = itemsBefore.has(itemKey(place)) ? undefined : gone.get(renameKey(place));
    if (renamed !== undefined) return { seen: renamed, firstSeenToday: false };
    return { seen: own ?? now, firstSeenToday: true };
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

/** The run's verdict, in counts alone: what fails it, and whether it passes. */
export function verdict(all: Row[], prove = false) {
  const open = all.filter((row) => !row.excepted);
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, open.filter((row) => row.severity === s).length]));
  const byBucket = Object.fromEntries(
    BUCKETS.map(([b]) => [b, open.filter((row) => row.bucket === b).length]),
  ) as Record<Bucket, number>;
  const fresh = open.filter(
    (row) => row.firstSeenToday && (row.severity === 'CRITICAL' || row.severity === 'HIGH'),
  ).length;
  const failing = fresh + byBucket.overdue + byBucket.day;
  const lines = [
    `Deadlines: ${open.length} open results, ${all.length - open.length} excepted. By severity: ${SEVERITIES.map((s) => `${s.toLowerCase()} ${bySeverity[s]}`).join(', ')}.`,
    `By deadline: ${BUCKETS.map(([b, name]) => `${name} ${byBucket[b]}`).join(', ')}.`,
    `New high or critical (first seen today): ${fresh}.`,
    failing
      ? prove
        ? `The real run would fail on ${fresh} new high or critical, ${byBucket.day} due within a day and ${byBucket.overdue} past their deadline; a proving run fails on none.`
        : `The run fails: ${fresh} new high or critical, ${byBucket.day} due within a day, ${byBucket.overdue} past their deadline.`
      : 'Nothing is new at high or critical, due within a day or past its deadline.',
  ];
  return { lines, bySeverity, byBucket, fresh, passes: prove || failing === 0 };
}

/** The whole judgement of a scan's hand-off, against the time given. */
export async function assess(handoff: Handoff, sources: Sources, now: number, log: (line: string) => void = () => {}) {
  const findings = handoff.findings;
  const [fixes, alerts] = await Promise.all([
    installable(findings, handoff.targets, sources, handoff.minimumReleaseAge ?? PNPM_DEFAULT_MINUTES, log),
    sources.alerts(handoff.started),
  ]);
  const ours = alerts.filter(isOurs);
  return {
    rows: rows(findings, new Set(handoff.excepted), fixes.at, seen(findings, handoff.targets, ours, now), now),
    looked: fixes.looked,
  };
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
  const first = repository.split('/')[0] ?? '';
  if (repository.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost'))
    return `docker://${repository}`;
  return `docker://docker.io/${repository.includes('/') ? '' : 'library/'}${repository}`;
}

/** The sources as the workflow has them: npm, Node's index, skopeo, Trivy on the scan's database, the API. */
export function realSources(
  handoff: Handoff,
  checkout: string,
  trivyImage: string,
  work: string,
  token?: string,
): Sources {
  const tools = realTools(trivyImage, handoff.cache, work);
  const times = new Map<string, Promise<Record<string, string>>>();
  // An error names the source, never the package asked for: the log gives counts alone.
  const get = async (url: string, source: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    // A package Trivy read is one npm has: a 404 is a source not read, not a package with no fix.
    if (!response.ok) throw new Error(`${source} answered ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  return {
    async published(name, version) {
      let once = times.get(name);
      if (!once) {
        once = tools.retry(async () => {
          const body = (await get(npmUrl(name), "npm's registry")) as { time?: Record<string, string> } | undefined;
          if (!body?.time || typeof body.time !== 'object') throw new Error("npm's registry gave no publish times");
          return body.time;
        });
        times.set(name, once);
      }
      return (await once)[version];
    },
    async releases() {
      const body = await tools.retry(() => get(NODE_INDEX, "Node's release index"));
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
    image: (reference) =>
      tools.retry(() => tools.trivy(['image', '--scanners', 'vuln', '--image-src', 'remote', '--', reference])),
    file(path) {
      const full = resolve(checkout, path);
      return full.startsWith(`${resolve(checkout)}/`) && existsSync(full) ? readFileSync(full, 'utf-8') : undefined;
    },
    async alerts(since) {
      if (!token) throw new Error('no token to read code scanning with');
      const api = realApi(token);
      const repository = handoff.repository;
      const [open, dismissed] = await Promise.all([
        alertsIn(api, repository, 'open'),
        alertsIn(api, repository, 'dismissed'),
      ]);
      // Those this run's upload closed: the most recently updated first, until one older than the run.
      const fixed = await alertsIn(api, repository, 'fixed', {
        query: '&sort=updated&direction=desc',
        while: (alert) => time(alert.updated_at ?? alert.fixed_at) >= time(since),
      });
      return [...open, ...dismissed, ...fixed];
    },
  };
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 300);

export async function main(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const [dir] = args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.match(/^--(checkout|trivy-pin)$/));
  const checkout = option('--checkout');
  const pinFile = option('--trivy-pin');
  const prove = args.includes('--prove');
  if (!dir || !checkout || !pinFile) {
    console.error(
      'Usage: GH_TOKEN=<token> deadlines.ts <scan out dir> --checkout <dir> --trivy-pin <Dockerfile> [--prove]',
    );
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
  const sources = realSources(handoff, checkout, pin[1], mkdtempSync(join(work, 'work-')), process.env.GH_TOKEN);
  const now = Date.now();
  let judged: Awaited<ReturnType<typeof assess>>;
  try {
    judged = await assess(handoff, sources, now, (line) => console.log(line));
  } catch (error) {
    console.error(`::error::The deadlines could not be read: ${firstLine(error)}. The run fails.`);
    return 1;
  }
  const { lines, bySeverity, byBucket, fresh, passes } = verdict(judged.rows, prove);
  const looked = `Read the publish times of ${judged.looked.npm} npm versions, and the newest image on ${judged.looked.images} image lines.`;
  for (const line of [looked, ...lines]) console.log(line);
  if (!passes) console.log(`::error::${lines.at(-1)}`);
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
        `New high or critical (first seen today): ${fresh}. ${lines.at(-1)}`,
        '',
      ].join('\n'),
    );
  return passes ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
