/**
 * The two repositories the factory looks after: its own, and the app's. Everything that decides by a repository's name
 * (which one the line works in, which the review gate routes as the app, whose `build.yml` signs which image) takes
 * these two, so the same code runs against scratch copies of both.
 *
 * Each is a setting, `FACTORY_REPOSITORY` and `APP_REPOSITORY`: in the environment of the factory's processes, and as
 * repository variables of the same names for the workflows, which only Martin sets. Unset or blank, each is the real
 * repository, as it is everywhere but in a try against copies. Both are under `the-roganator`, whose Apps are
 * installed on every repository there, and in lower case, as GHCR names their images. One that is not, or two that are
 * the same, stops whatever reads them.
 *
 * It imports nothing: the daily scan reads it in a sparse checkout, and the console's browser code imports it by name.
 */

/** Where both are: the factory's Apps are installed on every repository here. */
export const OWNER = 'the-roganator';

/** The real two, which an unset setting names. */
export const REAL = {
  factory: 'the-roganator/cv-software-factory',
  app: 'the-roganator/cv-worlds-worst-website',
} as const;

export interface Repositories {
  /** The factory's own repository, `owner/name`: its pins, its deploys, the workflows the app calls. */
  factory: string;
  /** The app's repository, `owner/name`, which the line works in. */
  app: string;
}

/** A name a setting may give: a repository under OWNER, in lower case. */
const NAME = new RegExp(`^${OWNER}/[a-z0-9][a-z0-9._-]*$`);

/** The two from an environment, `FACTORY_REPOSITORY` and `APP_REPOSITORY`, each the real one when unset or blank. */
export function repositoriesFrom(env: Readonly<Record<string, string | undefined>>): Repositories {
  const factory = named(env, 'FACTORY_REPOSITORY', REAL.factory);
  const app = named(env, 'APP_REPOSITORY', REAL.app);
  if (factory === app) throw new Error(`FACTORY_REPOSITORY and APP_REPOSITORY are both ${factory}: they must be two.`);
  return { factory, app };
}

function named(env: Readonly<Record<string, string | undefined>>, setting: string, real: string): string {
  const given = env[setting]?.trim();
  if (!given) return real;
  if (!NAME.test(given))
    throw new Error(`${setting} is ${JSON.stringify(given)}; it must be ${OWNER}/<name>, in lower case.`);
  return given;
}
