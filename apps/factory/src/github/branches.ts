/**
 * The branches the factory owns, and so the only ones the GitHub worker will move, delete or commit to. Everything
 * the line makes is under `factory/` (a fix is `factory/1296-prices`, the smoke run's base is `factory/smoke`, and the
 * deploy watch commits new pins on `factory/deploy/local` before moving the deploy branch to them); each deploy pull
 * request is on its repository's deploy branch, `deploy/local` (`deploys.ts`). Anything else, `main`
 * and Martin's branches above all, is refused before GitHub is asked, as a patch to a protected path is: the rulesets
 * guard `main` too, and this does not lean on them.
 */
import { DEPLOYS } from './deploys.ts';

/** Where every branch the line makes starts. */
export const FACTORY_PREFIX = 'factory/';

/**
 * Where every branch a red-team attack makes starts (`attacks.ts`): the factory's own, so the worker may make and
 * delete it, and never merged. A fix's branch starts with its work item's number, so none starts here.
 */
export const RED_TEAM_PREFIX = `${FACTORY_PREFIX}red-team-`;

export const redTeamBranch = (branch: string): boolean => branch.startsWith(RED_TEAM_PREFIX);

export class BranchRefused extends Error {
  override name = 'BranchRefused';
}

export const ownsBranch = (branch: string): boolean =>
  (branch.startsWith(FACTORY_PREFIX) && branch.length > FACTORY_PREFIX.length) ||
  DEPLOYS.some((target) => target.branch === branch);

/** Throws `BranchRefused` for a branch the factory does not own. */
export function guardBranch(branch: string): void {
  if (!ownsBranch(branch)) {
    throw new BranchRefused(
      `${branch} is not the factory's: it acts only on branches under ${FACTORY_PREFIX} and its deploy branches.`,
    );
  }
}
