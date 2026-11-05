/**
 * The index of a release's pictures (migrations 0010 and 0013): which pages were compared for which canary, with their
 * screenshots' references, and where each sense last boxed an element; and of a feature flag's pictures (0034), its
 * pages with the flag off and on, in each colour scheme, which Verify takes at Off and Checks (`probes/flag-check.ts`).
 * The images themselves are in the artifact store, which the probes worker writes; the line has no way to that store,
 * and reads this instead.
 */

import type { ColorScheme, Screenshot } from '@software-factory/events';
import type { ArtifactStore, OpenedArtifact } from '@software-factory/store';
import type { Sql } from 'postgres';
import type { Check } from '../capture.ts';

/**
 * A screenshot as the index keeps it: the reference an event carries, with the selector of the element each of its
 * boxes was drawn round, in the order of the boxes. A page carries the boxes of every sense that boxed something on it,
 * and the selectors are how the line keeps only a ticket's own (`line/pictures.ts`); no event carries them, nor more
 * boxes than an event's screenshot takes, which a page boxed by many checks has. A picture taken before the selectors
 * were kept has none.
 */
export type Shot = Screenshot & { selectors?: string[] };

/** One page compared: on the stable version (before) and on the canary (after). */
export interface Picture {
  canary: string;
  stable: string;
  path: string;
  route: string;
  before: Shot;
  after: Shot;
  /** The share of pixels that differ. */
  changed: number;
  /** Where they differ, or null when nothing does. */
  diff: Screenshot | null;
  /** The page on the stable Service after the canary was promoted, with the boxes; only for a page with any. */
  rollout: Shot | null;
}

/** Where a sense's signal was seen: the page its screenshot was taken on, and the elements it boxed there. */
export interface Look {
  sense: 'probe' | 'crawler';
  check: string;
  route: string;
  path: string;
  elements: Check[];
}

/**
 * A page of a feature flag's, pictured by Verify in one colour scheme: at `off`, the baseline, with the flag off; at
 * `checks`, with it on, against the page with it off in the same scheme when there is one.
 */
export interface FlagPicture {
  flag: string;
  stage: 'off' | 'checks';
  /** The flag set's revision the app reported, and its version. */
  revision: string;
  version: string;
  path: string;
  /** The colour scheme the browser said it preferred. */
  scheme: ColorScheme;
  route: string;
  shot: Screenshot;
  /** At checks, the share of pixels that differ from the page with the flag off: none without one. */
  changed: number | null;
  diff: Screenshot | null;
}

/** How long a flag's picture no event names is kept: longer than Verify takes from a run to its event. */
const FLAG_PICTURES_FOR_MS = 24 * 60 * 60_000;

/** How long a look is boxed on the pictures after it was last seen: a defect that long gone has been dealt with. */
const LOOKS_FOR_DAYS = 30;

interface PictureRow {
  canary: string;
  stable: string;
  path: string;
  route: string;
  before: Shot;
  after: Shot;
  changed: number;
  diff: Screenshot | null;
  rollout: Shot | null;
}

export class PictureIndex {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  /** The paths of a canary's pages compared with the stable version already. */
  async pictured(canary: string, stable: string): Promise<Set<string>> {
    const rows = await this.#sql<{ path: string }[]>`
      select path from pictures where canary = ${canary} and stable = ${stable}`;
    return new Set(rows.map((r) => r.path));
  }

  /** Records a canary's pictures, all or none. A page already recorded keeps what it has. */
  async record(pictures: readonly Picture[]): Promise<void> {
    if (!pictures.length) return;
    const sql = this.#sql;
    await sql.begin(async (tx) => {
      for (const p of pictures) {
        await tx`
          insert into pictures (canary, stable, path, route, before, after, changed, diff)
          values (${p.canary}, ${p.stable}, ${p.path}, ${p.route}, ${tx.json(p.before as never)},
                  ${tx.json(p.after as never)}, ${p.changed}, ${p.diff ? tx.json(p.diff as never) : null})
          on conflict do nothing`;
      }
    });
  }

  /** A canary's pictures against the stable version, in the order of their paths. */
  async of(canary: string, stable: string): Promise<Picture[]> {
    return this.#sql<PictureRow[]>`
      select canary, stable, path, route, before, after, changed, diff, rollout from pictures
      where canary = ${canary} and stable = ${stable} order by path`;
  }

  /** The pages of a version, pictured as a canary, still to be taken after its rollout: those with a box. */
  async awaitingRollout(version: string): Promise<Picture[]> {
    return this.#sql<PictureRow[]>`
      select canary, stable, path, route, before, after, changed, diff, rollout from pictures
      where canary = ${version} and rollout is null and jsonb_array_length(after->'boxes') > 0
      order by path`;
  }

  /** Records a page after the rollout, once. */
  async rolledOut(picture: Pick<Picture, 'canary' | 'stable' | 'path'>, shot: Shot): Promise<void> {
    await this.#sql`
      update pictures set rollout = ${this.#sql.json(shot as never)}
      where canary = ${picture.canary} and stable = ${picture.stable} and path = ${picture.path} and rollout is null`;
  }

  /**
   * Forgets the pictures of every release but the last `keep` pictured, the one whose canary `stable` now is (its pages
   * after the rollout may be still to take), and those a work item waits at Verify for: one promoted, carrying it, with
   * no verification, return or close of it since. First `remove` is given each of their images that nothing names any
   * more: no picture still kept (identical images are stored once), no event (whatever part of it names a hash), and
   * no signal triage has still to take. Then the rows go whose images are all gone, so an image whose removal failed
   * or was put off is offered again next time, and no picture kept ever names an image that is gone. Gives back how
   * many images were deleted.
   */
  async forget(keep: number, stable: string, remove: (hash: string) => Promise<boolean>): Promise<number> {
    const sql = this.#sql;
    const releases = await sql<{ canary: string; stable: string }[]>`
      with releases as (
        select canary, stable, max(taken_at) as taken from pictures group by canary, stable
      ), waiting as (
        select promoted.payload->>'version' as canary, promoted.payload->>'previous' as stable
        from events promoted
        where promoted.type = 'release.promoted' and promoted.work_item is not null
          and (promoted.payload->>'dryRun')::boolean is not true
          and not exists (
            select 1 from events since
            where since.work_item = promoted.work_item and since.seq > promoted.seq
              and since.type in ('verification.finished', 'work.returned', 'work-item.closed'))
      ), kept as (
        (select canary, stable from releases order by taken desc limit ${keep})
        union select canary, stable from releases where canary = ${stable}
        union select canary, stable from waiting
      )
      select canary, stable from releases
      where not exists (select 1 from kept where kept.canary = releases.canary and kept.stable = releases.stable)`;
    if (!releases.length) return 0;
    const forgotten = sql`(canary, stable) in (select * from unnest(${releases.map((r) => r.canary)}::text[],
      ${releases.map((r) => r.stable)}::text[]))`;
    // Every hash an event or a waiting signal names, read in one pass: an artifact is named by its SHA-256, so a
    // string of 64 hex digits anywhere in them may be one, and is kept.
    const unnamed = await sql<{ hash: string }[]>`
      with gone as (
        select distinct unnest(array[before->>'hash', after->>'hash', diff->>'hash', rollout->>'hash']) as hash
        from pictures where ${forgotten}
      ), named as (
        select m[1] as hash from events, regexp_matches(artifacts::text || payload::text, '([0-9a-f]{64})', 'g') m
        union select m[1] from inbox, regexp_matches(signal::text, '([0-9a-f]{64})', 'g') m where triaged_at is null
      )
      select hash from gone
      where hash is not null and hash not in (select hash from named)
        and not exists (
          select 1 from pictures
          where not ${forgotten}
            and (before->>'hash' = hash or after->>'hash' = hash or diff->>'hash' = hash or rollout->>'hash' = hash))
        and not exists (select 1 from flag_pictures where shot->>'hash' = hash or diff->>'hash' = hash)`;
    const left: string[] = [];
    for (const { hash } of unnamed) if (!(await remove(hash))) left.push(hash);
    await sql`
      delete from pictures where ${forgotten}
        and not (array[before->>'hash', after->>'hash', diff->>'hash', rollout->>'hash'] && ${left}::text[])`;
    return unnamed.length - left.length;
  }

  /**
   * A flag's page as Verify pictured it already, for the same stage, flag set, version and colour scheme: the same
   * picture.
   */
  async flagPicture(
    key: Pick<FlagPicture, 'flag' | 'stage' | 'revision' | 'version' | 'path' | 'scheme'>,
  ): Promise<FlagPicture | undefined> {
    const [row] = await this.#sql<FlagPicture[]>`
      select flag, stage, revision, version, path, scheme, route, shot, changed, diff from flag_pictures
      where flag = ${key.flag} and stage = ${key.stage} and revision = ${key.revision} and version = ${key.version}
        and path = ${key.path} and scheme = ${key.scheme}`;
    return row;
  }

  /**
   * The baseline's picture of a flag's page in a colour scheme, by its screenshot's hash: the page with the flag off.
   * A picture of the page in the other scheme is none of its.
   */
  async flagOff(flag: string, hash: string, scheme: ColorScheme): Promise<FlagPicture | undefined> {
    const [row] = await this.#sql<FlagPicture[]>`
      select flag, stage, revision, version, path, scheme, route, shot, changed, diff from flag_pictures
      where flag = ${flag} and stage = 'off' and shot->>'hash' = ${hash} and scheme = ${scheme}
      order by taken_at desc limit 1`;
    return row;
  }

  /** Records a flag's page as Verify pictured it. One recorded already keeps what it has. */
  async recordFlagPicture(p: FlagPicture): Promise<void> {
    const sql = this.#sql;
    await sql`
      insert into flag_pictures (flag, stage, revision, version, path, scheme, route, shot, changed, diff)
      values (${p.flag}, ${p.stage}, ${p.revision}, ${p.version}, ${p.path}, ${p.scheme}, ${p.route},
              ${sql.json(p.shot as never)}, ${p.changed}, ${p.diff ? sql.json(p.diff as never) : null})
      on conflict do nothing`;
  }

  /**
   * Forgets the flags' pictures no event came to name, a day after they were taken: a run the line never recorded,
   * because it could not tell what stage the app held, or Martin moved the flag meanwhile. One an event names is kept
   * as long as the event. First `remove` is given each of their images that nothing else names: no event, no other
   * flag's picture, no release's picture and no signal triage has still to take; then the rows go whose images are all
   * gone, as `forget` does. Gives back how many images were deleted.
   */
  async forgetFlagPictures(now: Date, remove: (hash: string) => Promise<boolean>): Promise<number> {
    const sql = this.#sql;
    const before = new Date(now.getTime() - FLAG_PICTURES_FOR_MS);
    // Named when a check's event carries its screenshot: each page's screenshots are among the event's artifacts.
    const forgotten = sql`taken_at < ${before} and not exists (
      select 1 from events e
      where e.type = 'flag.checked' and e.artifacts @> jsonb_build_array(jsonb_build_object('hash', shot->>'hash')))`;
    const unnamed = await sql<{ hash: string }[]>`
      with gone as (
        select distinct unnest(array[shot->>'hash', diff->>'hash']) as hash from flag_pictures where ${forgotten}
      ), named as (
        select m[1] as hash from events, regexp_matches(artifacts::text || payload::text, '([0-9a-f]{64})', 'g') m
        union select m[1] from inbox, regexp_matches(signal::text, '([0-9a-f]{64})', 'g') m where triaged_at is null
      )
      select hash from gone
      where hash is not null and hash not in (select hash from named)
        and not exists (
          select 1 from flag_pictures where not (${forgotten}) and (shot->>'hash' = hash or diff->>'hash' = hash))
        and not exists (
          select 1 from pictures
          where before->>'hash' = hash or after->>'hash' = hash or diff->>'hash' = hash or rollout->>'hash' = hash)`;
    const left: string[] = [];
    for (const { hash } of unnamed) if (!(await remove(hash))) left.push(hash);
    await sql`
      delete from flag_pictures where ${forgotten} and not (array[shot->>'hash', diff->>'hash'] && ${left}::text[])`;
    return unnamed.length - left.length;
  }

  /** Remembers where a sense boxed what it found, in place of where it last did for the same check. */
  async remember(look: Look, at: Date): Promise<void> {
    await this.#sql`
      insert into looks (sense, "check", route, path, elements, seen_at)
      values (${look.sense}, ${look.check}, ${look.route}, ${look.path}, ${this.#sql.json(look.elements as never)},
              ${at})
      on conflict (sense, "check", route)
      do update set path = excluded.path, elements = excluded.elements, seen_at = excluded.seen_at`;
  }

  /** The looks seen lately, to box on the pictures. */
  async looks(now: Date): Promise<Look[]> {
    const since = new Date(now.getTime() - LOOKS_FOR_DAYS * 24 * 60 * 60_000);
    return this.#sql<Look[]>`
      select sense, "check" as check, route, path, elements from looks where seen_at >= ${since}
      order by seen_at desc`;
  }

  /** Where a signal's own check last boxed what it found. */
  async lookOf(sense: string, check: string, route: string): Promise<Look | undefined> {
    const [look] = await this.#sql<Look[]>`
      select sense, "check" as check, route, path, elements from looks
      where sense = ${sense} and "check" = ${check} and route = ${route}`;
    return look;
  }
}

/**
 * The artifact store as the line sees it: the pictures the probes worker took and indexed, by their hash and size. An
 * event the line appends can carry those, and the store's writer checks that each is there, as it does any artifact;
 * the line cannot read the images, and has no need to.
 */
export class IndexedArtifacts implements ArtifactStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async put(): Promise<string> {
    throw new Error('The line keeps no artifacts of its own: the probes worker takes the pictures');
  }

  async size(hash: string): Promise<number | null> {
    // Each column's hash is indexed (migrations 0010 and 0034), so this does not read every picture.
    const [row] = await this.#sql<{ size: string }[]>`
      select size from (
        select before->>'hash' as hash, before->>'size' as size from pictures where before->>'hash' = ${hash}
        union all select after->>'hash', after->>'size' from pictures where after->>'hash' = ${hash}
        union all select diff->>'hash', diff->>'size' from pictures where diff->>'hash' = ${hash}
        union all select rollout->>'hash', rollout->>'size' from pictures where rollout->>'hash' = ${hash}
        union all select shot->>'hash', shot->>'size' from flag_pictures where shot->>'hash' = ${hash}
        union all select diff->>'hash', diff->>'size' from flag_pictures where diff->>'hash' = ${hash}
      ) as shots limit 1`;
    return row ? Number(row.size) : null;
  }

  async open(): Promise<OpenedArtifact | null> {
    return null;
  }
}
