/**
 * Martin's say on a pull request, from his reviews: what the review gate holds a pull request for when he asked for
 * changes, and what the GitHub worker reads the same way to say why a pull request waits. Pure, so the gate's script
 * and the worker's image share it.
 */

/** Martin's GitHub account, by its id, which never changes: a login can be renamed and taken by someone else. */
export const MARTIN = 6206459;

/** A review, as the reviews API gives a pull request's. */
export interface Review {
  /** The review's own number, which a `review_dismissed` event names. */
  id?: number;
  user: { id: number } | null;
  state: string;
  commit_id: string | null;
}

/** A pull request's issue event, as far as a dismissal of a review says by whom and what it said before. */
export interface Dismissal {
  event: string;
  actor: { id: number } | null;
  /** On `review_dismissed`: the review, and what it said before (`approved`, `changes_requested`). */
  dismissed_review?: { state: string; review_id: number };
}

/**
 * Martin's latest say on a pull request. A review that only comments says nothing; of the rest, his latest counts: an
 * approval, changes asked, or a review dismissed. `reviews` is in the order GitHub gives them, oldest first; `events`
 * are the pull request's issue events, which say who dismissed a review and what it said.
 *
 * `asked` says his latest is a request for changes, whatever commit he made it on: a push leaves it standing. His
 * approval after it ends it, and so does his own dismissal of it. Anyone with write access can dismiss a review, so a
 * dismissal by anyone else ends nothing, and nor does one whose event was not read: GitHub leaves `DISMISSED` as the
 * review's state, and only the event says by whom, and that it asked for changes. A dismissed approval is an approval
 * gone, whoever dismissed it, as GitHub does on a push.
 */
export type Say =
  | { say: 'none' }
  | { say: 'asked'; why: 'asked' | 'dismissal-unread' | 'dismissed-by-another' }
  | { say: 'dismissed' }
  | { say: 'approved'; commit: string | null };

export function latestSay(reviews: readonly Review[], events: readonly Dismissal[] = []): Say {
  const latest = reviews
    .filter((r) => r.user?.id === MARTIN && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .at(-1);
  if (!latest) return { say: 'none' };
  if (latest.state === 'CHANGES_REQUESTED') return { say: 'asked', why: 'asked' };
  if (latest.state === 'DISMISSED') {
    const dismissal =
      latest.id === undefined
        ? undefined
        : events.find((e) => e.event === 'review_dismissed' && e.dismissed_review?.review_id === latest.id);
    if (!dismissal) return { say: 'asked', why: 'dismissal-unread' };
    if (dismissal.dismissed_review?.state !== 'approved' && dismissal.actor?.id !== MARTIN)
      return { say: 'asked', why: 'dismissed-by-another' };
    return { say: 'dismissed' };
  }
  return { say: 'approved', commit: latest.commit_id };
}
