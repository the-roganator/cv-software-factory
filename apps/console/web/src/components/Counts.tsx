/**
 * Findings counted by severity, as Patching's summary and its sheet draw them (the design system's README, "Patching",
 * "Counts" and "Critical"): four counts, Critical to Low, under the headers C, H, M and L, each read at a glance (1.4K,
 * 11K) with the exact count as its title and in what a screen reader hears. Where a row has no headers over it, each
 * count follows its letter. A Critical above zero is in `attn`; a zero is muted; what the moves clear is a minus in
 * `ok`, whatever its severity. A count the day does not hold is a dash, never a figure worked out from another.
 */
import { count, glance } from '../format.ts';
import type { Counts } from '../projection/patching.ts';

const SEVERITY = ['Critical', 'High', 'Medium', 'Low'] as const;
const columns = (c: Counts) => [c.critical, c.high, c.medium, c.low];

/** "2 Critical, 45 High, 60 Medium, 12 Low", with the unrated after, when there are any. */
export const severityWords = (c: Counts) =>
  [
    ...columns(c).map((n, i) => `${count(n)} ${SEVERITY[i]}`),
    ...(c.unknown ? [`${count(c.unknown)} unrated`] : []),
  ].join(', ');

/** The headers, C, H, M and L, each named in full on a hover. A screen reader hears the counts' words instead. */
export function CountsHead() {
  return (
    <span className="clr clr-head" aria-hidden="true">
      {SEVERITY.map((name) => (
        <span key={name} title={name}>
          {name[0]}
        </span>
      ))}
    </span>
  );
}

/**
 * Four counts in four fixed columns. `words` is what a screen reader hears before them ("clears"); `cleared` draws
 * them as what goes, a minus in `ok`. With no counts, the day did not count them: a dash in each column.
 */
export function SeverityCounts({
  counts,
  words,
  cleared = false,
}: {
  counts: Counts | undefined;
  words: string;
  cleared?: boolean;
}) {
  if (!counts) {
    return (
      <span className="clr">
        <span className="sr">{words} not counted: the day’s scan is from before every open finding was counted</span>
        {SEVERITY.map((name) => (
          <span key={name} className="zero" aria-hidden="true" title="Not counted by the day’s scan">
            <i>{name[0]}</i>—
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="clr">
      <span className="sr">
        {words} {severityWords(counts)}
      </span>
      {columns(counts).map((n, i) => (
        <span
          key={SEVERITY[i]}
          className={n === 0 ? 'zero' : cleared ? 'cleared' : i === 0 ? 'crit' : undefined}
          title={count(n)}
          aria-hidden="true"
        >
          <i>{SEVERITY[i]?.[0]}</i>
          {cleared && n > 0 && '−'}
          {glance(n)}
        </span>
      ))}
    </span>
  );
}
