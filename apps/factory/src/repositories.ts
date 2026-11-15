/**
 * The two repositories the factory looks after, as this process is told them (policy/repositories.ts): the real two
 * unless `FACTORY_REPOSITORY` or `APP_REPOSITORY` names a copy. Read once, as the process starts; a name that is not
 * one stops it there.
 */
import { OWNER, repositoriesFrom } from '../../../policy/repositories.ts';

export const { factory: FACTORY_REPOSITORY, app: APP_REPOSITORY } = repositoriesFrom(process.env);

/** Both, the factory's first. */
export const REPOSITORIES = [FACTORY_REPOSITORY, APP_REPOSITORY] as const;

/**
 * The repository whose `build.yml` signs an image, from its name in GHCR (`ghcr.io/<owner>/<name>[/<image>]`): one of
 * the two, or undefined for any other.
 */
export function repositoryOfImage(image: string): string | undefined {
  const name = new RegExp(String.raw`^ghcr\.io/${OWNER}/([\w.-]+)(?:/[\w.-]+)?$`).exec(image)?.[1];
  const repository = name && `${OWNER}/${name}`;
  return REPOSITORIES.find((r) => r === repository);
}
