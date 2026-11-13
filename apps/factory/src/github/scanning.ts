/**
 * The vulnerability scan's day, as the GitHub worker reads it for the factory: the one door through which the factory
 * learns of a vulnerability.
 *
 * `moves` takes `moves.json` from the last finished run of `vulnerabilities.yml` on the default branch, by schedule,
 * push or hand (a pull request's run of the same workflow is never read, and a run still going is passed over), with
 * that run's conclusion; then it pages through the repository's open alerts in the scan's own categories
 * (`vulnerabilities/01` to `vulnerabilities/20`, never CodeQL's or Scorecard's), each message read by its one grammar
 * (sarif.ts's `readMessage`, through fixes.ts's readers), for what the artifact withholds: a lockfile move's package and
 * versions, and each move's findings.
 *
 * An alert's text is untrusted input. A message that does not parse, a move from another run than the artifact's (or,
 * while that run is still going, a read to try again) or past its list, or a count that differs from the artifact's,
 * fails the whole read, and nothing of it is returned: no word of an advisory is shown or acted on unless the scan's
 * own artifact agrees with it. Only the parts the grammar reads are returned: an advisory's id, never its title or its text.
 *
 * What the App lacks is named: a read refused for want of `actions: read` or `security_events: read` says which.
 *
 * A whole read is kept, one for each repository, and served again only while nothing it was read from has changed:
 * each call still asks which run is the last finished, whether a run of the scan is going, and when the scan's alerts
 * last changed (the one that changed last, of any state: a dismissal or reopening, by hand or by a run, and a run's
 * fixes, all change one; a run seeing an alert again does not, so no read is served from what was kept while a run is
 * going). A new run, a run going, a later change, or the run's artifact past its expiry is a whole read at once. A read
 * whose last change is under a minute older than the call that asked is not kept, so no later change shares its second
 * (GitHub times a change to the second). Callers at
 * once share one read in flight. A read that fails, or is asked for again (`READ_AGAIN`), is never kept.
 */
import { z } from 'zod';
import { isOurs } from '../vulnerabilities/alerts.ts';
import { dayText, type Fix, readMove, type Target, targetText } from '../vulnerabilities/fixes.ts';
import type { Kind } from '../vulnerabilities/inventory.ts';
import {
  type DayCounts,
  furthest,
  LANES,
  MOVES_VERSION,
  type MovesFile,
  type PublicMove,
  type ScannedImage,
} from '../vulnerabilities/moves.ts';
import { readMessage, SEVERITIES, type Severity } from '../vulnerabilities/sarif.ts';
import { type GitHub, GitHubError, READ_AGAIN } from './client.ts';
import { DIGEST } from './registry.ts';
import { type ZipError, zipEntry } from './zip.ts';

/** The scan's workflow, in both repositories: the app's calls the factory's. */
export const SCAN_WORKFLOW = 'vulnerabilities.yml';
/** The scan's artifact, and the file in it. */
export const MOVES_ARTIFACT = 'moves';
export const MOVES_FILE = 'moves.json';
/** The events a run of the scan on the default branch is read from: never a pull request's. */
export const SCAN_EVENTS: readonly string[] = ['schedule', 'push', 'workflow_dispatch'];

/** The most runs looked through for the last finished one, a page at a time. */
const RUN_PAGES = 5;
const RUNS_PER_PAGE = 20;
/** The most alerts read: code scanning keeps 5,000 results in each of the scan's 20 categories. */
export const MAX_ALERTS = 100_000;
const ALERTS_PER_PAGE = 100;
/** The most `moves.json` and its archive may hold: the day's moves, far below this. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

/** The run a day's moves came from. */
export interface ScanRun {
  id: number;
  event: string;
  /** The run's conclusion: `success`, `failure`, `cancelled`… */
  conclusion: string | null;
  headSha: string;
  /** When it last finished, as GitHub gives it. */
  updatedAt: string;
  url: string;
}

/** One finding a move clears, as its alert's message gives it, and the alert. */
export interface MoveFinding {
  alert: number;
  advisory: string;
  /** As the scan rated the result; the move's counts are by the higher of this and the publisher's (deadlines.ts). */
  severity: Severity;
  package: string;
  installed: string;
  file: string;
  line: number;
  /** What fixes it (fixes.ts's text), and the day that was first seen. */
  fix: string;
  firstSeen: string;
}

/** A move as `moves.json` gives it, with what the alerts hold. */
export interface ReadMove extends PublicMove {
  /** Its place in `moves.json`, from 1. */
  index: number;
  /**
   * What `moves.json` withholds of a lockfile's move, which it names only by its file: the package, its version, its
   * target and its pins, as the alerts give them. Absent for any other move, which the artifact names whole.
   */
  withheld?: { package: string; from: string; to: string; pins: { file: string; line: number }[] } | undefined;
  findings: MoveFinding[];
}

export interface Moves {
  repository: string;
  run: ScanRun;
  /**
   * The day as `moves.json` gives it; null only when the run failed before it wrote one, when its conclusion says
   * why. A successful run with none fails the read.
   */
  file: Omit<MovesFile, 'moves'> | null;
  moves: ReadMove[];
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);

const REPOSITORY = z.object({ default_branch: z.string().min(1) });

/** A repository's default branch: one conditional read, shared by every read of it. */
export async function defaultBranch(github: GitHub, repo: string): Promise<string> {
  const { body } = await github.poll(repo, `/repos/${repo}`, REPOSITORY);
  return body.default_branch;
}

const RUN = z.object({ status: z.string().nullable() });

const RUNS = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      event: z.string(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      head_branch: z.string().nullable(),
      head_sha: SHA,
      updated_at: z.string(),
      html_url: z.string(),
      head_repository: z.object({ full_name: z.string() }).nullable().optional(),
    }),
  ),
});

const ARTIFACTS = z.object({
  artifacts: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      expired: z.boolean(),
      expires_at: z.string().nullable().optional(),
      size_in_bytes: z.number().int().nonnegative(),
    }),
  ),
});

const ALERTS = z.array(
  z.object({
    number: z.number().int().positive(),
    state: z.string(),
    rule: z.object({ id: z.string().nullable().optional() }).nullable().optional(),
    tool: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
    most_recent_instance: z
      .object({
        category: z.string().optional(),
        message: z.object({ text: z.string().optional() }).optional(),
        location: z.object({ path: z.string().optional(), start_line: z.number().int().optional() }).optional(),
      })
      .nullable()
      .optional(),
  }),
);

/** The alert that changed last, whatever its state: what a kept read is checked against. */
const LATEST = z.array(
  z.object({
    number: z.number().int().positive(),
    state: z.string(),
    updated_at: z.string().nullable().optional(),
  }),
);

const COUNTS = z.strictObject(
  Object.fromEntries(SEVERITIES.map((s) => [s, z.number().int().nonnegative()])) as Record<Severity, z.ZodNumber>,
);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

/** Every kind of item inventory.ts lists that is an image: the compiler holds this to its `Kind`, both ways. */
const KINDS = [
  'ours',
  'third-party',
  'chart',
  'k3s',
  'k3s-release',
  'k3d',
  'dockerfile',
  'workflow',
] as const satisfies readonly Kind[];
const ALL_KINDS: Exclude<Kind, (typeof KINDS)[number] | 'lockfile'> extends never ? true : never = true;
void ALL_KINDS;

/**
 * An image reference by the distribution grammar (`[domain/]path[:tag][@digest]`), its digest a sha256 alone: what
 * the scan writes is an image GitHub's runner pulled, and anything else in its place is not one.
 */
const LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
/** A registry: a first part with a dot or a port, or `localhost`; anything else is the image's own path. */
const DOMAIN = String.raw`(?:(?:localhost|${LABEL}(?:\.${LABEL})+)(?::\d+)?|${LABEL}:\d+)/`;
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
export const IMAGE_REFERENCE = new RegExp(
  String.raw`^(?:${DOMAIN})?${COMPONENT}(?:/${COMPONENT})*(?::[\w][\w.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$`,
);

/** Text with no control character in it: a line, never a second one. */
const PLAIN = /^[^\p{Cc}]+$/u;
/** A path in the repository, as a pin names one: relative, and never up out of it. */
const PATH = z
  .string()
  .max(512)
  .regex(PLAIN)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'a path out of the repository');

/** One image the scan read, as moves.ts writes `ScannedImage`. */
const SCANNED = (
  z.strictObject({
    kind: z.enum(KINDS),
    item: z.string().max(1024).regex(PLAIN),
    image: z.string().max(512).regex(IMAGE_REFERENCE),
    digests: z
      .array(z.string().regex(DIGEST))
      .min(1)
      .refine((list) => new Set(list).size === list.length, 'a digest twice'),
    // An image's pin is a line of a file: the scan writes none at 0.
    pin: z.strictObject({ file: PATH, line: z.number().int().positive() }),
  }) satisfies z.ZodType<ScannedImage>
)
  // An image pinned by its digest has it among those read.
  .refine((entry) => {
    const pinned = entry.image.split('@')[1];
    return pinned === undefined || entry.digests.includes(pinned);
  }, 'an image whose digest is not among those read');

/** The day's figures beside the moves, as moves.ts writes `DayCounts`: each a count. */
const COUNT = z.number().int().nonnegative();
const DAY_COUNTS = {
  noFix: COUNT,
  excepted: COUNT,
  overdue: COUNT,
  dueWithinDay: COUNT,
  newHighWithFix: COUNT,
  newHighWithoutFix: COUNT,
} satisfies Record<keyof DayCounts, z.ZodNumber>;
// Every figure moves.ts writes is read: one it adds and this lacks does not compile.
const ALL_COUNTS: Exclude<keyof DayCounts, keyof typeof DAY_COUNTS> extends never ? true : never = true;
void ALL_COUNTS;

/** `moves.json`, as moves.ts writes it: a reader refuses a version it does not know. */
const MOVES_FILE_SCHEMA = z.strictObject({
  version: z.literal(MOVES_VERSION),
  repository: z.string(),
  judged: DAY,
  run: z.string().regex(/^\d+$/).optional(),
  totals: z.strictObject({
    fixed: z.number().int().nonnegative(),
    moves: z.number().int().nonnegative(),
    // The day's other figures, as the Patching panel shows them.
    ...DAY_COUNTS,
    lanes: z.strictObject(
      Object.fromEntries(LANES.map((lane) => [lane, z.number().int().nonnegative()])) as Record<
        (typeof LANES)[number],
        z.ZodNumber
      >,
    ),
  }),
  moves: z.array(
    z.strictObject({
      repository: z.string(),
      name: z.string(),
      pins: z.array(z.strictObject({ file: z.string(), line: z.number().int().nonnegative() })),
      from: z.string(),
      to: z.string(),
      major: z.boolean(),
      clears: COUNTS,
      leaves: COUNTS,
      deadline: DAY.optional(),
      newToday: z.number().int().nonnegative(),
      lane: z.enum(LANES as [(typeof LANES)[number], ...(typeof LANES)[number][]]),
      lockfile: z.boolean(),
    }),
  ),
  scanned: z
    .array(SCANNED)
    .refine((list) => new Set(list.map((each) => JSON.stringify(each))).size === list.length, 'an image twice'),
});

type Alerts = z.infer<typeof ALERTS>;

/** Whether an alert is open and the scan's own (alerts.ts's `isOurs`): Trivy's, in its categories. */
const ours = (alert: Alerts[number]) =>
  alert.state === 'open' &&
  isOurs({
    number: alert.number,
    state: alert.state,
    tool: { name: alert.tool?.name ?? '' },
    most_recent_instance: { category: alert.most_recent_instance?.category ?? '' },
  });

const total = (counts: Record<Severity, number>) => SEVERITIES.reduce((sum, s) => sum + counts[s], 0);

/** A read the scan's own artifact does not agree with: nothing of it is returned. */
const disagrees = (repo: string, why: string) =>
  new GitHubError('malformed', `The scan's moves in ${repo} cannot be read: ${why}.`);

/** The permissions the read needs, as GitHub names them. */
const NEEDED = ['actions', 'security_events'];

const lacksError = (repo: string, lacks: string[]) =>
  new GitHubError(
    'refused',
    `The factory's App cannot read the scan's moves in ${repo}: it lacks ${lacks.join(' and ')}.`,
    403,
  );

/** What the App lacks when GitHub refuses a read for it with a 403: a 404 is something missing, never a permission. */
const lacking = (error: unknown, permission: string) =>
  error instanceof GitHubError && error.kind === 'refused' && error.status === 403 ? permission : undefined;

/** What a whole read was read at: the last finished run, when the alerts last changed, and whether a run was going. */
interface ReadAt {
  run: number;
  /** The last change's time as GitHub gives it, `none` with no alert at all, undefined when GitHub does not say. */
  changed: string | undefined;
  going: boolean;
  /** When the worker asked, by its own clock: before GitHub answered any of the three. */
  asked: number;
}

/** How old the alerts' last change must be for a read to be kept: GitHub gives its time to the second, at best. */
export const SETTLED_MS = 60_000;

const same = (a: ReadAt, b: ReadAt) => a.run === b.run && a.changed === b.changed && a.going === b.going;
const changedAt = (at: ReadAt) => (at.changed === 'none' ? '' : (at.changed ?? ''));
/** Whether `a` is a later point than `b`: a later run, or the same one with a later change. */
const later = (a: ReadAt, b: ReadAt) => a.run > b.run || (a.run === b.run && changedAt(a) > changedAt(b));
/**
 * Whether a read at `at` may be kept, and so served again: no run going, and the last change a minute older than the
 * asking, so no change after it can share its second (see the module's comment).
 */
const keepable = (at: ReadAt) =>
  !at.going && at.changed !== undefined && (at.changed === 'none' || at.asked - Date.parse(at.changed) >= SETTLED_MS);
/**
 * Whether a caller at `at` may wait for the read in flight from `reading` instead of starting its own: one from the
 * same point, or from a later one, asked when a run was going if `at` saw one, and with a time if `at` had one.
 * Anything else is a read of its own.
 */
const joins = (at: ReadAt, reading: ReadAt) =>
  same(at, reading) ||
  (later(reading, at) && at.changed !== undefined && reading.changed !== undefined && (!at.going || reading.going));

/** The scan's moves: see the module's comment. */
export class ScanReads {
  readonly #github: GitHub;
  /** Each artifact's `moves.json`, by its id: an artifact never changes, so it is downloaded once. */
  readonly #files = new Map<number, unknown>();

  /** Each repository's last whole read, what it was read at, and until when its artifact is there to read again. */
  readonly #kept = new Map<string, { at: ReadAt; until: number; moves: Moves }>();
  /** Each repository's read in flight, which a caller asking at the same or an earlier point waits for. */
  readonly #reading = new Map<string, { at: ReadAt; read: Promise<{ until: number; moves: Moves }> }>();
  readonly #now: () => number;

  readonly #maxAlerts: number;

  /** `maxAlerts` for a test of the cap, the scan's own is `MAX_ALERTS`; `now` for a test of the clock. */
  constructor(
    github: GitHub,
    { maxAlerts = MAX_ALERTS, now = Date.now }: { maxAlerts?: number; now?: () => number } = {},
  ) {
    this.#github = github;
    this.#maxAlerts = maxAlerts;
    this.#now = now;
  }

  async moves(repo: string): Promise<Moves> {
    // Code scanning's alerts and a run's artifacts are read with the App's token alone, even on a public repository.
    if (!this.#github.writable)
      throw new GitHubError('read-only', `The worker has no App key, so it cannot read the scan's moves in ${repo}.`);
    // What the token may do, as GitHub granted it: a public repository's runs read without `actions: read`, and only
    // the artifact's download would be refused, so each permission is named before anything is asked.
    const granted = await this.#github.permissions(repo);
    if (granted) {
      const lacks = NEEDED.filter((permission) => !['read', 'write'].includes(granted[permission] ?? ''));
      if (lacks.length)
        throw lacksError(
          repo,
          lacks.map((permission) => `\`${permission}: read\``),
        );
    }
    const branch = await defaultBranch(this.#github, repo);
    // Whether a run is going is asked before which run is the last finished, so a run that finishes between the two
    // answers is seen by the second. Both permissions' reads first, so a read the App may not make names every
    // permission it lacks, not only the first.
    const asked = this.#now();
    const [going, latest] = await Promise.allSettled([this.#going(repo, branch), this.#latest(repo)]);
    const [runs] = going.status === 'fulfilled' ? await Promise.allSettled([this.#run(repo, branch)]) : [going];
    const missing = [
      runs.status === 'rejected' ? lacking(runs.reason, '`actions: read`') : undefined,
      latest.status === 'rejected' ? lacking(latest.reason, '`security_events: read`') : undefined,
    ].filter(Boolean);
    if (missing.length) throw lacksError(repo, missing as string[]);
    if (runs.status === 'rejected') throw runs.reason;
    if (latest.status === 'rejected') throw latest.reason;
    if (going.status === 'rejected') throw going.reason;
    const run = runs.value;
    const at: ReadAt = { run: run.id, changed: latest.value, going: going.value, asked };
    const kept = this.#kept.get(repo);
    if (kept && same(kept.at, at) && keepable(at) && this.#now() < kept.until) return structuredClone(kept.moves);
    let reading = this.#reading.get(repo);
    if (!reading || !joins(at, reading.at)) {
      const own = { at, read: this.#read(repo, run) };
      reading = own;
      this.#reading.set(repo, own);
      // Kept once whole if it may be, unless a later read was asked for meanwhile; a read that fails is never kept.
      own.read.then(
        ({ until, moves }) => {
          if (this.#reading.get(repo) !== own) return;
          this.#reading.delete(repo);
          if (keepable(at)) this.#kept.set(repo, { at, until, moves });
          else this.#kept.delete(repo);
        },
        () => {
          if (this.#reading.get(repo) === own) this.#reading.delete(repo);
        },
      );
    }
    return structuredClone((await reading.read).moves);
  }

  /** One whole read: every open alert, the run's `moves.json`, each held to the other, and when its artifact expires. */
  async #read(repo: string, run: ScanRun): Promise<{ until: number; moves: Moves }> {
    // The alerts and the artifact at once: neither waits on the other. The alerts' failure is the one named first.
    const [paged, file] = await Promise.allSettled([this.#alerts(repo), this.#file(repo, run)]);
    if (paged.status === 'rejected') {
      const lacks = lacking(paged.reason, '`security_events: read`');
      throw lacks ? lacksError(repo, [lacks]) : paged.reason;
    }
    if (file.status === 'rejected') throw file.reason;
    const alerts = paged.value;
    const found = file.value;
    if (!found) {
      if (run.conclusion === 'success') throw disagrees(repo, `run ${run.id} succeeded and left no ${MOVES_FILE}`);
      return { until: Number.POSITIVE_INFINITY, moves: { repository: repo, run, file: null, moves: [] } };
    }
    await this.#settled(repo, run, alerts);
    return { until: found.until, moves: { repository: repo, run, ...joined(repo, run, found.file, alerts) } };
  }

  /**
   * When the scan's alerts last changed: the one GitHub changed last, of any state. A dismissal, a reopening and a fix
   * each change one; an unchanged answer is GitHub's 304, which costs nothing against the rate limit. Undefined when
   * GitHub does not say, which no kept read is served for.
   */
  async #latest(repo: string): Promise<string | undefined> {
    const path = `/repos/${repo}/code-scanning/alerts?tool_name=Trivy&sort=updated&direction=desc&per_page=1`;
    const { body } = await this.#github.poll(repo, path, LATEST);
    const [last] = body;
    return last ? (last.updated_at ?? undefined) : 'none';
  }

  /** Whether a run of the scan on the default branch, by schedule, push or hand, is going: it may have uploaded. */
  async #going(repo: string, branch: string): Promise<boolean> {
    const path = `/repos/${repo}/actions/workflows/${SCAN_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&status=in_progress&exclude_pull_requests=true&per_page=${RUNS_PER_PAGE}`;
    const { body } = await this.#github.poll(repo, path, RUNS);
    return body.workflow_runs.some(
      (run) =>
        run.status !== 'completed' &&
        SCAN_EVENTS.includes(run.event) &&
        run.head_branch === branch &&
        run.head_repository?.full_name === repo,
    );
  }

  /**
   * A run uploads its artifact and then its results, and is still going while code scanning processes them and the
   * alerts are held to the policy: alerts that name a run still going, or a later run that finished while this read
   * paged through the alerts, are a read to try again, not a disagreement. Any other run than the artifact's fails the
   * read in `joined`.
   */
  async #settled(repo: string, run: ScanRun, alerts: z.infer<typeof ALERTS>) {
    // Only a later run than the artifact's can be a read to try again; any other fails the read in `joined`. The tags
    // are the alerts' words, so at most one later run is asked about: two are a disagreement.
    const later = new Set<string>();
    for (const alert of alerts) {
      if (!ours(alert)) continue;
      const tag = readMove(alert.most_recent_instance?.message?.text ?? '');
      if (tag && BigInt(tag.run) > BigInt(run.id)) later.add(tag.run);
    }
    if (later.size > 1) throw disagrees(repo, `its alerts name ${later.size} runs later than the artifact's`);
    const [other] = later;
    if (other === undefined) return;
    const { body } = await this.#github.poll(repo, `/repos/${repo}/actions/runs/${other}`, RUN);
    throw new GitHubError(
      READ_AGAIN,
      body.status === 'completed'
        ? `The scan's run ${other} in ${repo} finished while its moves were read: read them again.`
        : `The scan's run ${other} in ${repo} has uploaded its results and has not finished: read its moves once it has.`,
      409,
    );
  }

  /** The last finished run of the scan on the default branch, by schedule, push or hand. */
  async #run(repo: string, branch: string): Promise<ScanRun> {
    for (let page = 1; page <= RUN_PAGES; page++) {
      const path = `/repos/${repo}/actions/workflows/${SCAN_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&status=completed&exclude_pull_requests=true&per_page=${RUNS_PER_PAGE}&page=${page}`;
      const { body } = await this.#github.poll(repo, path, RUNS);
      const found = body.workflow_runs.find(
        (run) =>
          run.status === 'completed' &&
          SCAN_EVENTS.includes(run.event) &&
          run.head_branch === branch &&
          run.head_repository?.full_name === repo,
      );
      if (found)
        return {
          id: found.id,
          event: found.event,
          conclusion: found.conclusion,
          headSha: found.head_sha,
          updatedAt: found.updated_at,
          url: found.html_url,
        };
      if (body.workflow_runs.length < RUNS_PER_PAGE) break;
    }
    throw new GitHubError('not-found', `${repo} has no finished run of ${SCAN_WORKFLOW} on ${branch} to read.`, 404);
  }

  /** The run's `moves.json`, and when its artifact expires, or undefined when it uploaded none. */
  async #file(repo: string, run: ScanRun): Promise<{ file: MovesFile; until: number } | undefined> {
    const path = `/repos/${repo}/actions/runs/${run.id}/artifacts?name=${MOVES_ARTIFACT}&per_page=10`;
    const { body } = await this.#github.poll(repo, path, ARTIFACTS);
    const artifact = body.artifacts.find((each) => each.name === MOVES_ARTIFACT);
    if (!artifact) return undefined;
    if (artifact.expired)
      throw new GitHubError('not-found', `Run ${run.id}'s ${MOVES_ARTIFACT} artifact in ${repo} has expired.`, 404);
    if (artifact.size_in_bytes > MAX_ARCHIVE_BYTES) throw disagrees(repo, `run ${run.id}'s artifact is too large`);
    let json = this.#files.get(artifact.id);
    if (json === undefined) {
      const zip = await this.#github.download(
        repo,
        `/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
        MAX_ARCHIVE_BYTES,
      );
      let text: Buffer | undefined;
      try {
        text = zipEntry(zip, MOVES_FILE, MAX_FILE_BYTES);
      } catch (error) {
        throw disagrees(repo, `run ${run.id}'s artifact is not a readable archive (${(error as ZipError).message})`);
      }
      if (!text) throw disagrees(repo, `run ${run.id}'s artifact holds no ${MOVES_FILE}`);
      try {
        json = JSON.parse(text.toString('utf8'));
      } catch {
        throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} is not JSON`);
      }
      // A few days' artifacts at most: the oldest goes first.
      if (this.#files.size >= 16) this.#files.delete(this.#files.keys().next().value as number);
      this.#files.set(artifact.id, json);
    }
    const parsed = MOVES_FILE_SCHEMA.safeParse(json);
    if (!parsed.success) {
      const where = parsed.error.issues
        .slice(0, 3)
        .map((issue) => issue.path.join('.') || '(file)')
        .join(', ');
      throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} is not the shape this worker reads (${where})`);
    }
    // An artifact whose expiry GitHub does not give, or gives as no date, is read again on each call.
    const until = Date.parse(artifact.expires_at ?? '');
    return { file: parsed.data as MovesFile, until: Number.isNaN(until) ? 0 : until };
  }

  /** Every open alert of the repository's on the default branch, Trivy's, every page; more than `MAX_ALERTS` fails. */
  async #alerts(repo: string): Promise<z.infer<typeof ALERTS>> {
    const all: z.infer<typeof ALERTS> = [];
    for (let page = 1; ; page++) {
      const path = `/repos/${repo}/code-scanning/alerts?state=open&tool_name=Trivy&per_page=${ALERTS_PER_PAGE}&page=${page}`;
      const { body } = await this.#github.poll(repo, path, ALERTS);
      all.push(...body);
      if (all.length > this.#maxAlerts) throw disagrees(repo, `more than ${this.#maxAlerts} open alerts`);
      if (body.length < ALERTS_PER_PAGE) return all;
    }
  }
}

/**
 * The artifact's moves with their alerts, each checked against the other: every result with a fix names its move in
 * this run, every move has as many findings as it clears, and the total is the artifact's.
 */
export function joined(
  repo: string,
  run: ScanRun,
  file: MovesFile,
  alerts: z.infer<typeof ALERTS>,
): { file: Omit<MovesFile, 'moves'>; moves: ReadMove[] } {
  if (file.repository !== repo) throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} is another repository's`);
  if (file.run !== String(run.id))
    throw disagrees(repo, `run ${run.id}'s ${MOVES_FILE} names ${file.run ? `run ${file.run}` : 'no run'}`);
  if (file.totals.moves !== file.moves.length)
    throw disagrees(repo, `${MOVES_FILE} counts ${file.totals.moves} moves and lists ${file.moves.length}`);
  const cleared = file.moves.reduce((sum, move) => sum + total(move.clears), 0);
  if (file.totals.fixed !== cleared)
    throw disagrees(
      repo,
      `${MOVES_FILE} counts ${file.totals.fixed} results with a fix and its moves clear ${cleared}`,
    );

  const findings: MoveFinding[][] = file.moves.map(() => []);
  const fixes: Fix[][] = file.moves.map(() => []);
  for (const alert of alerts) {
    if (!ours(alert)) continue;
    const advisory = alert.rule?.id ?? '';
    const message = readMessage(alert.most_recent_instance?.message?.text ?? '', advisory);
    if (!advisory || !message) throw disagrees(repo, `alert ${alert.number}'s message does not parse`);
    if (!message.fix) continue;
    const move = message.move;
    // A result with a fix and no move is excepted (moves.ts leaves those out), its alert open until the run's next step
    // dismisses it: it is in no move. One the artifact counts and lacks fails the counts below.
    if (!move) continue;
    if (move.run !== String(run.id))
      throw disagrees(repo, `alert ${alert.number} is from run ${move.run}, and the artifact from run ${run.id}`);
    const list = findings[move.index - 1];
    if (!list) throw disagrees(repo, `alert ${alert.number} names move ${move.index} of ${file.moves.length}`);
    list.push({
      alert: alert.number,
      advisory,
      severity: message.severity,
      package: message.package,
      installed: message.installed,
      file: alert.most_recent_instance?.location?.path ?? '',
      line: alert.most_recent_instance?.location?.start_line ?? 0,
      fix: targetText(message.fix.target),
      firstSeen: dayText(message.fix.day),
    });
    fixes[move.index - 1]?.push(message.fix);
  }

  const moves = file.moves.map((move, i): ReadMove => {
    const own = (findings[i] ?? []).sort((a, b) => a.alert - b.alert);
    if (own.length !== total(move.clears))
      throw disagrees(repo, `move ${i + 1} clears ${total(move.clears)} results and ${own.length} alerts name it`);
    return { ...move, index: i + 1, ...lockfileOf(repo, move, i, own, fixes[i] ?? []), findings: own };
  });
  const read = moves.reduce((sum, move) => sum + move.findings.length, 0);
  if (read !== file.totals.fixed)
    throw disagrees(
      repo,
      `${MOVES_FILE} counts ${file.totals.fixed} results with a fix and ${read} alerts name a move`,
    );
  const { moves: _, ...rest } = file;
  return { file: rest, moves };
}

/**
 * What `moves.json` withholds of a lockfile's move, from its findings: one package at one version, as moves.ts groups
 * it, in the files the artifact names.
 */
function lockfileOf(repo: string, move: PublicMove, i: number, own: MoveFinding[], fixes: Fix[]) {
  if (!move.lockfile) return {};
  const packages = new Set(own.map((each) => each.package));
  const versions = new Set(own.map((each) => each.installed));
  const [name] = packages;
  const [from] = versions;
  if (packages.size !== 1 || versions.size !== 1 || name === undefined || from === undefined)
    throw disagrees(repo, `move ${i + 1}, a lockfile's, has findings of more than one package or version`);
  const to: Target | undefined = furthest(fixes.map((fix) => fix.target));
  const pins = [
    ...new Map(own.map((each) => [`${each.file}:${each.line}`, { file: each.file, line: each.line }])).values(),
  ];
  pins.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  // The artifact names the move's files: its findings must be in exactly those.
  const named = [...new Set(move.pins.map((pin) => pin.file))].sort().join('\n');
  const found = [...new Set(pins.map((pin) => pin.file))].sort().join('\n');
  if (named !== found) throw disagrees(repo, `move ${i + 1}, a lockfile's, has findings outside the files it names`);
  return { withheld: { package: name, from, to: to ? targetText(to) : '', pins } };
}
