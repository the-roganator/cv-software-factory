/**
 * Patching's and Guardrails' summaries, in the bottom row's right column between Flags and Spend (the design system's
 * README, "Patching" and "Guardrails", "The summary"). Each answers "do I need to look?" in a few lines, then opens its
 * panel whole in a sheet of its own (`Patching.tsx`, `Guardrails.tsx`), whose code arrives only then.
 *
 * One needs Martin when a move waits on him, a deadline is within a day or past, the scan failed, or a guardrail did
 * not hold: then it takes Needs you's `attn` rule down its left edge, and each reason is in `attn`, in words. A Critical
 * count and a guardrail not proved yet are not reasons. The same for a visitor, with "Martin" for "you"; a summary holds
 * no control, so it carries no "Read only".
 *
 * A chunk of its own, with its stylesheet and Patching's projection, loaded with the bottom row's and drawn with it.
 */
import { memo, type ReactNode } from 'react';
import { ago, clock, dayLabel, plural, startOfDay } from '../format.ts';
import type { GuardrailsView, View } from '../projection/index.ts';
import { dueSoon, dueWords, nextDue, type PatchingRow, type PatchingView } from '../projection/patching.ts';
import { renders } from '../renders.ts';
import { CountsHead, SeverityCounts } from './Counts.tsx';
import { Glyph, type GlyphName } from './Glyph.tsx';
import { heldWords, LAST_RUN, movesWords, READS, waitWords } from './panel-words.ts';
import { usePatching } from './use-patching.ts';
import '../styles/summaries.css';

/** One line of a summary: a glyph and a few words, in a tone. */
function Line({ glyph, tone, children }: { glyph: GlyphName; tone?: string | undefined; children: ReactNode }) {
  return (
    <li className={tone ? `tone-${tone}` : undefined}>
      <Glyph name={glyph} />
      <span>{children}</span>
    </li>
  );
}

/** "today", or the day it was. */
const onDay = (at: number, t: number) => (startOfDay(at) === startOfDay(t) ? 'today' : `on ${dayLabel(at)}`);

/** A move's name as the summary says it: a lockfile's package the public view withholds is the file's. */
const nameOf = (row: PatchingRow) => row.name ?? 'a package in a lockfile';

/** When the next deadline is: "in 21 h", or "3 h ago" for one already past. */
const nextWords = (deadline: number, t: number) => {
  const words = dueWords(deadline, t);
  return words.endsWith(' past') ? `${words.slice(0, -' past'.length)} ago` : words;
};

const PatchingCard = memo(function PatchingCard({
  view,
  t,
  martin,
  onSheet,
}: {
  view: PatchingView;
  t: number;
  martin: boolean;
  onSheet: () => void;
}) {
  renders.patching = (renders.patching ?? 0) + 1;
  if (view.state === 'unread') {
    return (
      <article className="panel summary" id="patching-summary" aria-labelledby="patching-summary-title">
        <div className="panel-head">
          <h2 id="patching-summary-title">Patching</h2>
          <span className="label">No read yet</span>
        </div>
        <p className="help">
          The dependency sense has not read a day’s scan yet. It reads each morning, after the scan, and when it starts.
        </p>
        <div className="links">
          <button type="button" className="linkish" onClick={onSheet}>
            Open Patching
          </button>
        </div>
      </article>
    );
  }
  const { day } = view;
  const next = nextDue(view.rows);
  const soon = next !== undefined && dueSoon(next.deadline, t);
  const unscanned = view.running['unlisted-image'];
  const failed = !day.passed;
  // Each row the sense made waits on Martin, so an unscanned image running is counted among those that wait.
  const needs = view.waiting > 0 || soon || failed;
  const clears = view.clears;
  const nothing = clears.critical + clears.high + clears.medium + clears.low + clears.unknown === 0;
  return (
    <article
      className={needs ? 'panel summary attn' : 'panel summary'}
      id="patching-summary"
      aria-labelledby="patching-summary-title"
    >
      <div className="panel-head">
        <h2 id="patching-summary-title">Patching</h2>
        <span className="label">
          {movesWords(view.moves)}
          {view.waiting > 0 && (
            <>
              {' · '}
              <span className="tone-attn">{waitWords(view.waiting, martin)}</span>
            </>
          )}
        </span>
      </div>
      <div className="sum-clr">
        <div aria-hidden="true">
          <span />
          <CountsHead />
        </div>
        <div>
          <span>All open</span>
          <SeverityCounts counts={view.open} words="All open:" />
        </div>
        <div>
          <span>{nothing ? 'Nothing to clear' : 'The moves clear'}</span>
          <SeverityCounts counts={clears} words={nothing ? 'Nothing to clear:' : 'The moves clear'} cleared />
        </div>
      </div>
      <ul className="sum-lines">
        {unscanned > 0 && (
          <Line glyph="ring" tone="attn">
            {plural(unscanned, 'unscanned image')} running
          </Line>
        )}
        {next?.deadline !== undefined ? (
          <Line glyph="ring" tone={soon ? 'attn' : undefined}>
            Next due {nextWords(next.deadline, t)}
            {soon && `: ${nameOf(next)}`}
          </Line>
        ) : (
          <Line glyph="dash">No deadline to meet</Line>
        )}
        {failed ? (
          <Line glyph="cross" tone="attn">
            Scan failed {onDay(day.finished, t)} · {clock(day.finished)}
          </Line>
        ) : (
          <Line glyph="check" tone="ok">
            Scan passed {onDay(day.finished, t)} · {clock(day.finished)}
          </Line>
        )}
      </ul>
      <div className="links">
        <button type="button" className="linkish" onClick={onSheet}>
          {view.moves > 0 ? `All ${plural(view.moves, 'move')}` : 'Open Patching'}
        </button>
      </div>
    </article>
  );
});

/** Patching's summary, from the fold the console's view was drawn from: the same view its sheet draws. */
export function PatchingSummary({
  view: drawn,
  martin,
  onSheet,
}: {
  view: View;
  martin: boolean;
  /** Opens Patching's sheet. */
  onSheet: () => void;
}) {
  const { view, t } = usePatching(drawn);
  return <PatchingCard view={view} t={t} martin={martin} onSheet={onSheet} />;
}

/** The newest of some times, if any. */
const newest = (times: readonly number[]) => (times.length ? Math.max(...times) : undefined);

/** Guardrails' summary: how many hold, the eleven as a strip, the last proof and the last attack. */
export function GuardrailsSummary({
  view,
  now,
  martin,
  onSheet,
}: {
  view: GuardrailsView;
  /** The page's time, which each age counts from. */
  now: number;
  martin: boolean;
  /** Opens Guardrails' sheet. */
  onSheet: () => void;
}) {
  const failed = view.rows.filter((row) => row.state === 'not-held');
  // The newest proof that held: one that did not is on a line of its own.
  const proved = newest(view.rows.flatMap((row) => (row.state === 'held' && row.proof ? [row.proof.at] : [])));
  const attacks = view.rows.flatMap((row) => (row.attack?.available && row.attack.last ? [row.attack] : []));
  const last = attacks.reduce<(typeof attacks)[number] | undefined>(
    (latest, attack) => (!latest?.last || (attack.last && attack.last.at > latest.last.at) ? attack : latest),
    undefined,
  );
  return (
    <article
      className={failed.length ? 'panel summary attn' : 'panel summary'}
      id="guardrails-summary"
      aria-labelledby="guardrails-summary-title"
    >
      <div className="panel-head">
        <h2 id="guardrails-summary-title">Guardrails</h2>
        <span className={failed.length ? 'label tone-attn' : 'label'}>{heldWords(view)}</span>
      </div>
      {/* One picture, not eleven controls: the sheet is one press away. */}
      <div
        className="gr-strip"
        role="img"
        aria-label={`The eleven, in order: ${view.rows.map((row) => `${row.n} ${READS[row.state][0].toLowerCase()}`).join(', ')}`}
      >
        {view.rows.map((row) => {
          const [word, tone, glyph] = READS[row.state];
          return (
            <span
              key={row.n}
              className={`tone-${tone}${row.state === 'not-held' ? ' is-attn' : ''}`}
              title={`${row.n} · ${row.name}: ${word}`}
            >
              <Glyph name={glyph} />
              <span>{row.n}</span>
            </span>
          );
        })}
      </div>
      <ul className="sum-lines">
        {failed.map((row) => (
          <Line key={row.n} glyph="cross" tone="attn">
            {row.n} did not hold{row.proof && `, ${ago(row.proof.at, now)}`}: {row.name}.{' '}
            {martin ? 'You were' : 'Martin was'} paged.
          </Line>
        ))}
        <Line glyph={proved === undefined ? 'dash' : 'check'}>
          {proved === undefined ? 'Not proved yet' : `Last proved ${ago(proved, now)}`}
          {view.unproved > 0 && (
            <>
              {' · '}
              <b>make guardrails</b> proves {view.unproved === view.rows.length ? 'all eleven' : 'the rest'}
            </>
          )}
        </Line>
        {last?.last ? (
          <Line glyph={LAST_RUN[last.last.verdict][2]} tone={LAST_RUN[last.last.verdict][1]}>
            {last.last.verdict === 'running'
              ? `An attack is running: ${last.name}`
              : `Last attack: ${last.name} · ${LAST_RUN[last.last.verdict][0]}, ${ago(last.last.at, now)}`}
          </Line>
        ) : (
          <Line glyph="dash" tone="faint">
            No attack launched yet
          </Line>
        )}
      </ul>
      <div className="links">
        <button type="button" className="linkish" onClick={onSheet}>
          All eleven guardrails
        </button>
      </div>
    </article>
  );
}
