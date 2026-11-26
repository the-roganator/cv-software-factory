/**
 * The exceptions to the vulnerability scan (docs/COMPONENTS/SECURITY-SCANNING.md#exceptions): each a finding the scan
 * and the lockfile gate let stand, for one item of one repository, because it cannot reach us there, until its expiry.
 *
 * The daily scan and the lockfile gate read this file from this repository's `main` alone, whatever commit their caller
 * pins, so it imports nothing: a sparse checkout of it is all they need. An entry is in force from the day it reaches
 * `main` to its expiry, and only while that expiry is at most `MAX_DAYS` away: one that has passed, or is further off,
 * excepts nothing, and the scan names it to be removed. The scan dismisses the alert of each finding an entry in force
 * excepts (won't fix, its comment the reason and the expiry) and reopens any alert of its own categories dismissed with
 * none, so their state is this file's and nothing else's.
 *
 * `scripts/osv-scanner.ts <repository>` writes each repository's `osv-scanner.toml` from it, which Scorecard reads.
 */

export interface Exception {
  /** The repository the finding is in, `owner/name`, one of the factory's REPOSITORIES. */
  repository: string;
  /**
   * The item, as the repository's list names it (`inventory.ts <checkout>`): a lockfile's path, an image's reference, a
   * chart's Application. An image's digest is left out, so a refresh of the same tag keeps the exception; a new tag is
   * a new image, judged again.
   */
  item: string;
  /** The advisory: a CVE id, or GitHub's GHSA id. */
  advisory: string;
  /** The package the finding is in, as Trivy names it. */
  package: string;
  /** Why it cannot reach us in that item. */
  reason: string;
  /** The last day it is in force, `YYYY-MM-DD`, UTC: at most MAX_DAYS from the day the scan runs. */
  expires: string;
}

/** The furthest an expiry may be from the day the scan runs. */
export const MAX_DAYS = 90;

/** An advisory id the scan's results carry. */
export const ADVISORY = /^(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/;

export const EXCEPTIONS: Exception[] = [];

/**
 * A package or an image the scan lists no routine move for (apps/factory/src/vulnerabilities/routine.ts), and why: it
 * names one or the other. A finding's move of it is made as any other.
 */
export type Left = {
  /** The repository it is left alone in, `owner/name`, or `all` for both. */
  repository: string;
  /** Set, for a package, where only a move its manifest's range does not admit is left, and one within it is listed. */
  major?: true;
  /** Why the scan leaves it. */
  reason: string;
} & (
  | {
      /** The package, as its lockfile names it. */
      package: string;
      image?: never;
    }
  | {
      /** The image's repository, as its pin writes it, with neither tag nor digest (`ghcr.io/open-feature/flagd`). */
      image: string;
      package?: never;
    }
);

/** The wait before a pin that is merely behind is listed as a move, and what is never listed so. */
export interface Routine {
  /** How long a release waits, in days, before a pin with no finding is moved to it. */
  days: number;
  /** The same for a major: a chart's next major, or a release its manifest's range does not admit. */
  majorDays: number;
  leave: Left[];
}

/**
 * The scan lists a pin that is behind, with no finding, as a routine move once the release it would move to has
 * waited: most malicious releases are pulled within hours, and the first release of a major is the one most often
 * followed by a fix (postgres.js 4.0.0 lost LISTEN after a failed reconnect, and 4.1.0 fixed it a week later). A fix
 * for a finding does not wait here: it has its own waits (pnpm's `minimumReleaseAge`, mise's `minimum_release_age`).
 */
export const ROUTINE: Routine = {
  days: 3,
  majorDays: 7,
  leave: [
    {
      repository: 'all',
      package: '@types/node',
      major: true,
      reason: "Node's own types follow the Node mise.toml pins, which moves only when someone upgrades the toolchain.",
    },
    // Playwright's library and its browsers' image are one release: the image's move brings the library in the
    // lockfile (the pin step's `moveImage`), so the image's routine move is the one move.
    { repository: 'all', package: 'playwright', reason: "It moves with Playwright's image, which brings it." },
    { repository: 'all', package: 'playwright-core', reason: "It moves with Playwright's image, which brings it." },
    { repository: 'all', package: '@playwright/test', reason: "It moves with Playwright's image, which brings it." },
    {
      repository: 'all',
      image: 'ghcr.io/open-feature/flagd',
      reason:
        "The FeatureFlag kind's definition beside its Deployment is vendored at the version of OpenFeature's operator API flagd builds against, so a release that moves that moves the definition too, by hand, and Martin holds a bump until its release is two weeks old.",
    },
    {
      repository: 'all',
      package: '@anthropic-ai/claude-agent-sdk',
      reason:
        "The SDK is the agent loop every step runs in, and the tests replay cassettes: its bump merges only after a bench run on Claude, which is Martin's to start.",
    },
  ],
};

/** A day, `YYYY-MM-DD`, as a count of days, or undefined for anything else. */
function day(text: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text ? undefined : at / 86_400_000;
}

/** Why an entry excepts nothing on the day given (an ISO date or a Date), or undefined while it is in force. */
export function lapsed(entry: Exception, today: Date | string = new Date()): string | undefined {
  const now = day(typeof today === 'string' ? today : today.toISOString().slice(0, 10));
  const expires = day(entry.expires);
  if (now === undefined) return `the day ${String(today)} cannot be read`;
  if (expires === undefined) return `its expiry ${entry.expires} is not a day written YYYY-MM-DD`;
  if (expires < now) return `it expired on ${entry.expires}`;
  if (expires - now > MAX_DAYS) return `its expiry ${entry.expires} is more than ${MAX_DAYS} days away`;
  return undefined;
}

/** An image's reference without its digest; anything else as it is. */
export function withoutDigest(item: string) {
  const at = item.indexOf('@sha256:');
  return at < 0 ? item : item.slice(0, at);
}

/** Whether an entry is for this finding: its repository, its item, its package and its advisory, each exactly. */
export function covers(
  entry: Exception,
  finding: { repository: string; item: string; package: string; advisory: string },
) {
  return (
    entry.repository === finding.repository &&
    withoutDigest(entry.item) === withoutDigest(finding.item) &&
    entry.package === finding.package &&
    entry.advisory === finding.advisory
  );
}

/** The entry in force that excepts a finding on the day given, if any. */
export function exceptionFor(
  entries: readonly Exception[],
  finding: { repository: string; item: string; package: string; advisory: string },
  today: Date | string = new Date(),
) {
  return entries.find((entry) => covers(entry, finding) && !lapsed(entry, today));
}

/** The comment an excepted finding's alert is dismissed with, within code scanning's 280 characters. */
export function dismissal(entry: Exception) {
  const text = `Excepted in policy/vulnerabilities.ts until ${entry.expires}: ${entry.reason}`;
  return text.length > 280 ? `${text.slice(0, 279)}…` : text;
}

/**
 * The longest ago, in hours, a scan of `main` may have been judged (`moves.json`'s `judged`) and still be judged by:
 * the scan runs each day, so a day and a half is one run missed. The review gate takes an older one for no judgement,
 * and a change that would pass by it as a move waits for the next scan (scripts/moves.ts).
 */
export const SCAN_MAX_AGE_HOURS = 36;
