/**
 * The branches the factory owns, and so the only ones the GitHub worker will move, delete or commit to. Everything
 * the line makes is under `factory/` (a fix is `factory/1296-prices`, the smoke run's base is `factory/smoke`, and the
 * deploy watch commits new pins on `factory/deploy/local` before moving the deploy branch to them); each deploy pull
 * request is on its repository's deploy branch, `deploy/local` (`deploys.ts`). Anything else, `main`
 * and Martin's branches above all, is refused before GitHub is asked, as a patch to a protected path is: the rulesets
 * guard `main` too, and this does not lean on them.
 *
 * The pin watch's branches (`factory/pin/<move>`, and `factory/pin-next/<move>` where each commit is made before its
 * branch moves to it) are written by one action alone, `commitPins`, whose guard lets a commit replace the version or
 * digest at each pin and nothing else (`pin-guard.ts`): every other action that moves, deletes or commits to a branch
 * refuses them, so no patch, commit or branch move asked of the worker can put anything else on one.
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

/** Where the pin watch's branches start (`pins.ts`), and where each of its commits is made before its branch moves. */
export const PIN_PREFIX = `${FACTORY_PREFIX}pin/`;
export const PIN_NEXT_PREFIX = `${FACTORY_PREFIX}pin-next/`;

/** Whether a branch is one only `commitPins` writes, or the prefix of one, which no branch of anyone else's may be. */
export const pinBranch = (branch: string): boolean =>
  branch.startsWith(PIN_PREFIX) ||
  branch.startsWith(PIN_NEXT_PREFIX) ||
  `${branch}/` === PIN_PREFIX ||
  `${branch}/` === PIN_NEXT_PREFIX;

/** Throws `BranchRefused` for a branch the factory does not own. */
export function guardBranch(branch: string): void {
  if (!ownsBranch(branch)) {
    throw new BranchRefused(
      `${branch} is not the factory's: it acts only on branches under ${FACTORY_PREFIX} and its deploy branches.`,
    );
  }
}

/**
 * Throws `BranchRefused` for a branch the factory does not own, or one of the pin watch's, which only `commitPins`
 * writes: what every other action that moves, deletes or commits to a branch asks.
 */
export function guardWritable(branch: string): void {
  guardBranch(branch);
  if (pinBranch(branch)) {
    throw new BranchRefused(
      `${branch} is the pin watch's: only a pin move's own commit, which replaces a version or digest at each pin and nothing else, goes on it.`,
    );
  }
}
