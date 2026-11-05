/**
 * A feature flag checked with the probes, for the line's Verify by variant (milestone 7, task 17): the probes worker,
 * which has the browser the line's image lacks, runs the journeys and the `/device` check against the stable Service,
 * and pictures the pages the improvement's spec names, each in both colour schemes. Every request it makes carries the
 * mark (`UNMEASURED`), which the flag's targeting turns it on for from Checks: so with the flag at Off it sees the flag
 * off, and from Checks on.
 *
 *     POST /v1/flag-check   { "flag": "gift-note", "stage": "checks", "revision": "r12", "pages": ["/"], "base": {...} }
 *       ->  202 while it runs; then 200 <FlagCheckAnswer>
 *
 * Asked and polled as `/v1/verify` is (`probes/verify.ts`), one run at a time with the verifications, and asking again
 * with the same request joins the run.
 *
 * - **At Off**, the baseline: the journeys, and each page with the flag off. Given the version a baseline was last taken
 *   of (`have`), and the app still on it, nothing is run.
 * - **At Checks**: the journeys compared with the baseline's by the journeys gate's rule (`gates/journeys.ts`), the
 *   `/device` check among them, so a check that passed cleanly with the flag off and fails twice with it on regressed;
 *   and each page with the flag on, against the baseline's picture of it in the same colour scheme.
 *
 * Each page is pictured twice, with the browser saying it prefers a light colour scheme and then a dark one
 * (`prefers-color-scheme`), so a change that answers to either shows in its pictures. The pictures are evidence for
 * Martin, never judged: the journeys run once, in the browser's default.
 * - **At Preview**: a probe first asks the app to preview the flag, as the console's link does, and the journeys are
 *   compared as at Checks; the `/device` check lists the preview cookie as allowed when it keeps to its contract.
 *
 * Each run first reads the revision of the flag set the app holds (`x-flags-revision`, as the admin service reads it)
 * and the version it runs, and reads both again after: a revision other than the one asked for (Martin's latest move
 * has not reached the app, or another came since) or a version that moved says the run may not have seen the stage it
 * was asked about, and nothing is judged.
 */
import { COLOR_SCHEMES, type ColorScheme, cutAt, cutTo, type Screenshot } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import { z } from 'zod';
import { type Count, compareJourneys, keyOf, type Seen } from '../gates/journeys.ts';
import { compare } from '../pictures/compare.ts';
import type { PictureIndex } from '../pictures/index.ts';
import { FLAG_NAME } from '../senses/device.ts';
import { templater } from '../senses/routes.ts';
import { PREVIEW_CHECK } from './index.ts';

/** The header the app tells a marked request its flag set's revision in (FEATURE-FLAGS.md, "The revision"). */
export const REVISION_HEADER = 'x-flags-revision';

/** The most pages a check pictures, as `flag.checked` names them: each in both colour schemes. */
export const MOST_PAGES = 6;
/** The most checks a baseline names as not clean, as `flag.checked` takes them. */
export const MOST_NOT_CLEAN = 200;

/** A path on the app: never one a URL would read as another host's (`//host`, `/\\host`). */
const path = z
  .string()
  .regex(/^\/(?![/\\])[^\s?#\\]*$/)
  .max(200);
const version = z.string().regex(/^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
/** A check of the baseline that did not pass cleanly: failed, or could not tell. */
const notClean = z.strictObject({
  sense: z.enum(['probe', 'crawler']),
  check: z.string().min(1).max(120),
  route: z.union([
    z.literal('*'),
    z
      .string()
      .regex(/^\/[^\s]*$/)
      .max(200),
  ]),
  failed: z.boolean(),
  message: z.string().max(300).optional(),
});

/** What the line asks. */
export const flagCheckRequest = z.strictObject({
  flag: z.string().max(100).regex(FLAG_NAME),
  stage: z.enum(['off', 'checks', 'preview']),
  /** The revision the app must report before the run and after: Martin's latest move's, or `none` before his first. */
  revision: z.string().regex(/^[!-~]{1,128}$/),
  /** The pages to picture, at Off and Checks. */
  pages: z.array(path).max(MOST_PAGES),
  /** At Off: the version a baseline was last taken of. The app still on it, nothing is run. */
  have: version.optional(),
  /** At Checks and Preview: the baseline to compare with, or none when there is none. */
  base: z
    .strictObject({
      version,
      notClean: z.array(notClean).max(MOST_NOT_CLEAN),
      /** Its picture of each page in each colour scheme, by the screenshot's hash. */
      pictures: z
        .array(z.strictObject({ path, scheme: z.enum(COLOR_SCHEMES), hash }))
        .max(MOST_PAGES * COLOR_SCHEMES.length),
    })
    .nullable()
    .optional(),
});
export type FlagCheckRequest = z.infer<typeof flagCheckRequest>;
export type NotClean = z.infer<typeof notClean>;

/**
 * A page as a check pictured it in a colour scheme: with the flag off at Off; at Checks, on, against the baseline's
 * picture of it in the same scheme.
 */
export interface CheckedPage {
  path: string;
  scheme: ColorScheme;
  route: string;
  off?: Screenshot;
  on?: Screenshot;
  changed?: number;
  diff?: Screenshot;
}

/** What a run found: the journeys, compared with the baseline's when there was one, the device, and the pages. */
export interface Checked {
  kind: 'checked';
  version: string;
  revision: string;
  /** How many of the journeys' checks ran, and passed cleanly. */
  journeys: Count;
  /** Each check that did not pass cleanly: the baseline's base for the stages after. */
  notClean: NotClean[];
  /** Against the baseline, at Checks and Preview: each check that passed cleanly there and failed twice here. */
  regressions?: NotClean[];
  /** What the `/device` check found, over every probe: the preview cookie allowed, and anything else kept. */
  device: { allowed: string[]; kept: string[] };
  pages: CheckedPage[];
}

export type FlagCheckAnswer =
  /** At Off, the app still on the version a baseline was taken of: nothing was run. */
  | { kind: 'have'; version: string }
  /** The run may not have seen the stage it was asked about, and judges nothing: why, in words. */
  | { kind: 'not-held'; version: string | null; message: string }
  | Checked;

/** How the run reaches the app: what it reports of itself, the probes, and a page's picture. */
export interface FlagCheckDeps {
  /** What `/version` says; rejects when the app does not answer. */
  version(): Promise<string>;
  /** The revision the app reports to a marked request, or undefined when it reports none. */
  revision(): Promise<string | undefined>;
  /**
   * Runs the probes once, with the `/device` check, or only those that make `only`, asking first to preview `preview`:
   * as `senses/observe.ts` does, with the version before and after.
   */
  observe(
    only: readonly Pick<Seen, 'sense' | 'check'>[] | undefined,
    preview: string | undefined,
  ): Promise<{ version: string; seen: Seen[]; after: string | null }>;
  /** Pictures a page of the app, with the mark, in a colour scheme: its PNG and its reference. */
  shoot(
    path: string,
    shot: { route: string; version: string; scheme: ColorScheme },
  ): Promise<{ png: Uint8Array; screenshot: Screenshot }>;
  index: Pick<PictureIndex, 'flagPicture' | 'flagOff' | 'recordFlagPicture'>;
  log: { warn(fields: object, message: string): void };
  /** Where the screenshots are, and the diffs go. */
  store: ArtifactStore;
}

/** A check that ran but did not pass cleanly: one that failed, or could not finish. */
const bad = (s: Seen) => s.failed || s.trouble !== undefined;

const asNotClean = (s: Seen): NotClean => ({
  sense: s.sense === 'crawler' ? 'crawler' : 'probe',
  check: cutAt(s.check, 120),
  route: s.route,
  failed: s.failed,
  ...((s.message ?? s.trouble) && { message: cutTo((s.message ?? s.trouble ?? '').trim(), 300) }),
});

/**
 * The checks the preview probe's watch makes of the front page, which say nothing of the flag: the probes after it
 * watch the same page, and the baseline has none of its checks to compare them with. Its own check, whether the ask
 * was answered, and its `/device` check are kept.
 */
const watchOfThePreview = (s: Pick<Seen, 'check'>) =>
  s.check.startsWith(`${PREVIEW_CHECK}/`) && s.check !== `${PREVIEW_CHECK}/device`;

export async function flagCheck(deps: FlagCheckDeps, request: FlagCheckRequest): Promise<FlagCheckAnswer> {
  const version = await deps.version();
  // The flag set first: a baseline of this version is one of the flag set it saw, which the app must hold still.
  const held = await heldOrWhy(deps, request.revision);
  if (held) return { kind: 'not-held', version, message: held };
  if (request.stage === 'off' && request.have === version) return { kind: 'have', version };
  const preview = request.stage === 'preview' ? request.flag : undefined;
  const moved: string[] = [];
  // The whole run, each check as last seen: one that failed and passed when run again passed, as the gate counts it.
  const seen = new Map<string, Seen>();
  const observe = async (only?: readonly Pick<Seen, 'sense' | 'check'>[]) => {
    const looked = await deps.observe(only, preview);
    if (looked.version !== version) moved.push(`The app moved to ${looked.version}`);
    else if (looked.after === null) moved.push('The app did not say its version after the run');
    else if (looked.after !== version) moved.push(`The app moved to ${looked.after}`);
    // Named as an event keeps them, so the baseline's names and this run's are the same.
    const kept = looked.seen.filter((s) => !watchOfThePreview(s)).map((s) => ({ ...s, check: cutAt(s.check, 120) }));
    for (const s of kept) seen.set(keyOf(s), s);
    return kept;
  };
  const base = request.stage === 'off' ? undefined : request.base;
  let regressions: Seen[] | undefined;
  if (base) {
    // The journeys gate's comparison, with the baseline as its base: a check it names is one that did not pass
    // cleanly with the flag off, and one it does not name passed.
    const comparison = await compareJourneys(
      async (app, only) =>
        app === 'base'
          ? base.notClean.map(
              ({ sense, check, route, failed, message }): Seen => ({
                sense,
                check,
                route,
                failed,
                ...(failed ? message !== undefined && { message } : { trouble: message ?? 'Could not tell' }),
              }),
            )
          : observe(only),
      'base',
      'change',
    );
    regressions = comparison.regressions;
  } else {
    // A check that did not pass cleanly is run again, as the gate does, so one flake does not make a check the
    // baseline says nothing of.
    const first = await observe();
    const again = first.filter(bad);
    if (again.length) await observe(again);
  }
  const pages = request.stage === 'preview' ? [] : await picture(deps, request, version);
  const after = await deps.version().catch(() => null);
  if (after !== version)
    moved.push(after === null ? 'The app did not say its version after the run' : `The app moved to ${after}`);
  const [why] = moved;
  if (why) return { kind: 'not-held', version, message: why };
  const still = await heldOrWhy(deps, request.revision);
  if (still) return { kind: 'not-held', version, message: `After the run: ${still}` };
  const run = [...seen.values()];
  const devices = run.filter((s) => s.check.endsWith('/device'));
  return {
    kind: 'checked',
    version,
    revision: request.revision,
    journeys: { passed: run.filter((s) => !bad(s)).length, ran: run.length },
    notClean: run.filter(bad).map(asNotClean),
    ...(regressions && { regressions: regressions.map(asNotClean) }),
    device: {
      allowed: [...new Set(devices.flatMap((s) => s.allowed ?? []))],
      kept: [...new Set(devices.flatMap((s) => s.kept ?? []))],
    },
    pages,
  };
}

/** Why the app is not seen holding the revision asked for, or nothing when it is. */
async function heldOrWhy(deps: FlagCheckDeps, revision: string): Promise<string | undefined> {
  const held = await deps.revision().catch(() => undefined);
  if (held === revision) return undefined;
  return held === undefined
    ? 'The app did not say which flag set it holds'
    : `The app holds the flag set ${held}, not ${revision}`;
}

/**
 * Each page in each colour scheme, pictured with the mark: at Off, the flag off; at Checks, on, and compared with the
 * baseline's picture of it in the same scheme, which the index vouches is one of the baseline's. A page pictured
 * already for the same stage, flag set, version and scheme is that picture again. A page that cannot be pictured in a
 * scheme is left out of it, and the run goes on.
 */
async function picture(deps: FlagCheckDeps, request: FlagCheckRequest, version: string): Promise<CheckedPage[]> {
  const stage = request.stage === 'off' ? 'off' : 'checks';
  const routeOf = templater(request.pages);
  const pages: CheckedPage[] = [];
  for (const path of request.pages) {
    for (const scheme of COLOR_SCHEMES) {
      const page = await pictureOne(deps, request, { stage, version, path, scheme, route: routeOf(path) });
      if (page) pages.push(page);
    }
  }
  return pages;
}

/** A page in a colour scheme, as `picture` takes it: undefined when it could not be pictured. */
async function pictureOne(
  deps: FlagCheckDeps,
  request: FlagCheckRequest,
  {
    stage,
    version,
    path,
    scheme,
    route,
  }: { stage: 'off' | 'checks'; version: string; path: string; scheme: ColorScheme; route: string },
): Promise<CheckedPage | undefined> {
  const key = { flag: request.flag, stage, revision: request.revision, version, path, scheme } as const;
  const offHash = request.base?.pictures.find((p) => p.path === path && p.scheme === scheme)?.hash;
  // The baseline's picture of the page in this scheme, which the index vouches for: never a file the request merely
  // names.
  const off =
    stage === 'checks' && offHash ? (await deps.index.flagOff(request.flag, offHash, scheme))?.shot : undefined;
  let taken = await deps.index.flagPicture(key);
  if (!taken) {
    let shot: Awaited<ReturnType<FlagCheckDeps['shoot']>>;
    try {
      shot = await deps.shoot(path, { route, version, scheme });
    } catch (error) {
      // Left out of the answer, which names only the pages pictured; the run goes on.
      deps.log.warn({ flag: request.flag, path, scheme, err: String(error) }, 'a page of a flag could not be pictured');
      return undefined;
    }
    const against = off && (await bytesOf(deps.store, off.hash));
    const comparison = against ? compare(against, shot.png) : undefined;
    taken = {
      ...key,
      route,
      shot: shot.screenshot,
      changed: comparison ? Math.ceil(comparison.changed * 10_000) / 10_000 : null,
      diff:
        comparison?.diff && off
          ? {
              ...shot.screenshot,
              hash: await deps.store.put(comparison.diff),
              size: comparison.diff.byteLength,
              width: Math.max(off.width, shot.screenshot.width),
              height: Math.max(off.height, shot.screenshot.height),
              boxes: [],
            }
          : null,
    };
    await deps.index.recordFlagPicture(taken);
  }
  return {
    path,
    scheme,
    route: taken.route,
    ...(stage === 'off' ? { off: taken.shot } : { ...(off && { off }), on: taken.shot }),
    ...(taken.changed !== null && { changed: taken.changed }),
    ...(taken.diff && { diff: taken.diff }),
  };
}

/** An artifact's bytes, or undefined when the store does not have it. */
async function bytesOf(store: ArtifactStore, hash: string): Promise<Uint8Array | undefined> {
  const opened = await store.open(hash);
  if (!opened) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of opened.body) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/** A check's request as its run is known by: asking again with the same joins it. */
export const flagCheckKey = (r: FlagCheckRequest): string =>
  JSON.stringify([r.flag, r.stage, r.revision, r.pages, r.have ?? null, r.base?.version ?? null]);
