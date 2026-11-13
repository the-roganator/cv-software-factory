/**
 * How the scoreboard counts tickets against the answer key (spec section 3.2): the rule that decides whether a ticket
 * found an entry, and how often the count of entries found may move.
 *
 * Human-owned: see `README.md`. The scoreboard (`apps/factory/src/scoreboard`) applies this rule, and the private
 * repository, which holds the answer key, imports this file to check that its own count agrees. So it imports
 * nothing and its types are plain shapes: the private repository has none of the factory's dependencies.
 */

/** What identifies a defect from outside, as a ticket and an answer key's entry both give it. */
export type Fingerprint =
  /** A symptom class on a route, or on `*`: every page the senses checked. */
  | { route: string; class: string }
  /** For content: the page, and the passage of its text that is wrong. */
  | { page: string; text: string };

/** One entry of the answer key, as the scoreboard is given it: its id and fingerprint, and nothing else. */
export interface KeyEntry {
  id: string;
  fingerprint: Fingerprint;
}

/**
 * Whether a ticket counts on the scoreboard at all: a defect's does, by a route or a page. A dependency's ticket, which
 * names a move (its name and ecosystem), does not, found or false positive (milestone 7, task 35): a scan finds a
 * vulnerable pin by reading it, not by noticing a symptom, so it says nothing of how well the senses find defects.
 * Patching has its own measure on its panel.
 */
export function counts(ticket: object): boolean {
  return 'route' in ticket || 'page' in ticket;
}

/** A symptom found on every page the senses checked. */
export const EVERY_ROUTE = '*';

/**
 * Whether a ticket's fingerprint finds an entry's. A symptom class must be the same, on the same route; an entry on
 * every route is found by a ticket of its class on any route, but a ticket on every route finds only an entry on
 * every route, so a ticket that names no page cannot claim each entry of its class. For content, the page must be
 * the same and the entry's passage must be in the ticket's, ignoring case: the factory quotes the page as it read it,
 * and may quote more of it than the entry does.
 */
export function matches(ticket: Fingerprint, entry: Fingerprint): boolean {
  if ('route' in entry) {
    return (
      'route' in ticket && ticket.class === entry.class && (entry.route === EVERY_ROUTE || ticket.route === entry.route)
    );
  }
  return 'page' in ticket && ticket.page === entry.page && ticket.text.toLowerCase().includes(entry.text.toLowerCase());
}

/**
 * How often the count of entries found may move, in hours. A ticket opens in the public event store, so a count that
 * moved as it opened would tell anyone watching whether that ticket found an entry. Found counts the entries found by
 * tickets opened before the last boundary (boundaries are every `foundEveryHours` from midnight UTC), and every entry
 * already verified fixed. The cadence hides a ticket's verdict among those opened in the same window, so a window
 * with one ticket hides little.
 *
 * Verified, and with it the median time to a fix, moves as soon as it changes, so that the console can show a fix
 * counted as it is verified. That does tell anyone watching whether a ticket just verified found an entry: by then its
 * defect is fixed, and saying so is what the scoreboard is for.
 */
export const SCOREBOARD = {
  /** A divisor of 24, so that the boundaries fall on the same hours each day. */
  foundEveryHours: 6,
} as const;
