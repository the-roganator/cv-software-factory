/**
 * The mark that finds a work item's issue again: a comment at the end of the issue's body, which GitHub does not show,
 * naming the work item by its number, as the body's first line does in words. The line writes it on every issue it
 * opens for a work item, and the GitHub worker, asked to open an issue whose body carries one, gives back the open
 * issue of the App's that already carries it, saying what is asked now, rather than open a second
 * (`LiveActions.openIssue`): the line may ask again after a failure between GitHub's answer and its own record of it.
 * Anyone can write the same words in an issue of their own, so only an issue the App opened is found by it.
 */
const MARK = /<!-- factory: work-item ([1-9]\d{0,8}) -->/;

/** The mark for a work item, as the last line of its issue's body. */
export const workItemMark = (workItem: string): string => `<!-- factory: work-item ${workItem} -->`;

/** The mark a body carries, if it carries one. */
export const workItemMarkOf = (body: string | null | undefined): string | undefined => MARK.exec(body ?? '')?.[0];

/** How many pages of a repository's open issues, a hundred each and the newest first, are read to find one again. */
export const MARK_PAGES = 10;
