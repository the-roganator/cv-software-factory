/**
 * Text cut to fit what an event, a title or a summary holds: the factory's one way to cut, so none splits a
 * character a string holds as two UTF-16 units (an emoji), which the store refuses as JSON and a page shows as a
 * broken glyph.
 */

/**
 * `text` at most `max` characters long: as it is when it fits, or its start ending in `…`, the mark counted, cut
 * between characters and never inside one, with no space left before the mark. For words someone reads.
 */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${cutAt(text, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * `text`'s first `max` units, with no mark, less the first half of a character the cut would split. For text that
 * names something (a check, a passage a fingerprint holds, a line a pattern is made from): it is `text.slice(0, max)`
 * whenever the cut falls between characters, so a name cut before stays the same name.
 */
export function cutAt(text: string, max: number): string {
  const kept = text.slice(0, Math.max(0, max));
  return kept.length < text.length && /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}

/**
 * What became of a build that carries a held work item and was not signed (`build.unsigned`), in the words the line's
 * summary and the console share: "The build of 1a2b3c4 that carries it was never signed: sign and attest did not
 * succeed".
 */
export function unsignedBuildWords({
  commit,
  signature,
  job,
}: {
  commit: string;
  signature: 'unsigned' | 'refused';
  job?: { name: string } | undefined;
}): string {
  const why =
    signature === 'refused' ? 'has no signature of its pipeline’s that its check accepts' : 'was never signed';
  return `The build of ${commit.slice(0, 7)} that carries it ${why}${job ? `: ${job.name} did not succeed` : ''}`;
}
