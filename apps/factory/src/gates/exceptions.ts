/**
 * The exceptions as the app's three dependency gates read them: the lockfile scan, the image scan and dependency
 * review. Each takes the entries of `policy/vulnerabilities.ts` from this repository's `main` (the workflow puts
 * `main`'s in place of the checkout's before anything runs) and asks this one function which of its findings an entry
 * in force excepts, for the repository the gate judges (GITHUB_REPOSITORY) and the item it reads: a lockfile by its
 * path, the app's image by its reference in GHCR. An expired entry, or one for another item or repository, excepts
 * nothing in any of them, so the three agree on what is excepted and none has a bypass of its own.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */
import { EXCEPTIONS, type Exception, exceptionFor } from '../../../../policy/vulnerabilities.ts';

/** A lockfile pnpm may install from: `pnpm-lock.yaml`, or a branch's `pnpm-lock.<name>.yaml`, at any depth. */
export const LOCKFILE = /(^|\/)pnpm-lock(\.[^/]+)?\.yaml$/;

/**
 * The item a repository's own image is on its list (`inventory.ts`, an image of ours, less its digest): the gate builds
 * the image from the change, so it is named by the repository the gate judges, never by anything in the change.
 */
export const ownImage = (repository: string) => `ghcr.io/${repository.toLowerCase()}`;

/** What a gate knows of a finding: the item it is in, its package and its advisory. */
export interface Judged {
  item: string;
  package: string;
  advisory: string;
}

/**
 * The findings an entry in force excepts on the day given, each with its entry's expiry, and the rest: the entries of
 * policy/vulnerabilities.ts, or others, for the tests.
 */
export function except<T>(
  findings: readonly T[],
  repository: string,
  judged: (finding: T) => Judged,
  entries: readonly Exception[] = EXCEPTIONS,
  today: Date | string = new Date(),
) {
  const excepted: (T & { expires: string })[] = [];
  const failing: T[] = [];
  for (const finding of findings) {
    const entry = exceptionFor(entries, { repository, ...judged(finding) }, today);
    if (entry) excepted.push({ ...finding, expires: entry.expires });
    else failing.push(finding);
  }
  return { excepted, failing };
}

/**
 * The entries in force on the day given for the repository's lockfiles: those dependency review is given as the
 * advisories it allows, as the lockfile scan excepts each for its own lockfile.
 */
export function lockfileEntries(
  repository: string,
  entries: readonly Exception[] = EXCEPTIONS,
  today: Date | string = new Date(),
) {
  return entries.filter(
    (entry) =>
      LOCKFILE.test(entry.item) &&
      exceptionFor([entry], { repository, item: entry.item, package: entry.package, advisory: entry.advisory }, today),
  );
}
