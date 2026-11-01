/**
 * The sheet's Release and Verify: one block for each release that carried the work item, newest first and the older
 * ones folded, each with its steps against the version before, how it ended, and what Verify found after it. While a
 * merged fix waits for Martin's deploy, that wait is the section's first block.
 */
import { clock, clockSeconds, duration, isCommit, percent, shortVersion, shortWhen } from '../format.ts';
import type { Release, Sheet as SheetData, Shipped, Verified } from '../projection/index.ts';
import { marksNote, SENSE } from '../projection/index.ts';
import { endedAt, figureOf, phaseOf, rollouts, standing } from '../projection/release.ts';
import { VERDICT, Verdict } from './Canary.tsx';
import { Glyph } from './Glyph.tsx';
import { ToolMark } from './Logos.tsx';
import { Picture, Shot } from './Pictures.tsx';

export function ShippedSection({ sheet }: { sheet: SheetData }) {
  const { shipped, deploy } = sheet;
  const own = sheet.card.number;
  if (!shipped.length && !deploy) return null;
  return (
    <section className="sec">
      <h3>Release and Verify</h3>
      <p className="help">
        Each release that carried it, newest first: the canary’s steps against the version before, then what the sense
        that saw the problem found after full rollout.
      </p>
      <div className="rels">
        {/* The wait for Martin's deploy is the card's picture, the waiting-on-Martin panel, at a card's width. */}
        {deploy && (
          <div className="deploy-wait">
            <Picture picture={deploy} interactive={false} />
          </div>
        )}
        {/* While it waits for Martin's deploy, the wait is the section's one block. */}
        {!deploy &&
          shipped.map((s, i) => (
            <Block key={`${s.release.id}-${s.release.startedAt}`} shipped={s} own={own} folded={i > 0} />
          ))}
      </div>
    </section>
  );
}

/** One release: its head, then, unfolded, its facts, steps, end and verification. */
function Block({
  shipped: { release: r, verification },
  own,
  folded,
}: {
  shipped: Shipped;
  own: string;
  folded: boolean;
}) {
  const [word, tone, dot] = standing(r);
  const head = (
    <>
      <span className="label">
        Release {r.id} · {shortWhen(r.startedAt)}
      </span>
      <span className={`out tone-${tone}`}>
        <span className={`dot ${dot}`} aria-hidden="true" />
        {word}
      </span>
      {r.dryRun && <span className="pill-sample">Dry run</span>}
    </>
  );
  const body = (
    <>
      <Facts r={r} own={own} />
      <Steps r={r} />
      <Ending r={r} />
      {rollouts(r) && (
        <p className="source">
          <ToolMark name="argo" />
          <span>Argo CD synced the deploy that carried it, and Argo Rollouts {r.end ? 'ran' : 'runs'} its canary.</span>
        </p>
      )}
      {verification && <Verify v={verification} />}
    </>
  );
  if (folded)
    return (
      <details className="rel">
        <summary className="rel-head">
          {head}
          <span className="more">Show this release</span>
        </summary>
        {body}
      </details>
    );
  return (
    <article className="rel">
      <div className="rel-head">{head}</div>
      {body}
    </article>
  );
}

/** The release in one line: the versions, the commit, the image, and the other work items it carried. */
function Facts({ r, own }: { r: Release; own: string }) {
  const { image } = r;
  const others = r.items.filter((i) => i.number !== own);
  return (
    <p className="rel-facts">
      <b>
        {shortVersion(r.previous)} → {shortVersion(r.version)}
      </b>
      {r.commit && !isCommit(r.version) && ` · commit ${r.commit.slice(0, 7)}`}
      {image
        ? ` · ${image.digest.slice(0, 11)}…${image.digest.slice(-4)}${image.signed ? ' · signed' : ''}${image.admitted ? ' · admitted' : ''}`
        : ' · no image: nothing shipped'}
      {others.length > 0 && ` · with ${others.map((i) => `#${i.number}`).join(', ')}`}
    </p>
  );
}

/** A figure on the canary, and the baseline's under it. */
const Pair = ({ r, m, name }: { r: Release; m: Release['measured'][number]; name: string }) => (
  <>
    {figureOf(r, m, name, 'canary')}
    <small>{figureOf(r, m, name, 'baseline')}</small>
  </>
);

/** A verdict's glyph, in its tone, with its word for a screen reader. */
function Mark({ phase }: { phase: keyof typeof VERDICT }) {
  const [word, tone, glyph] = VERDICT[phase];
  return (
    <span className={`v tone-${tone}`}>
      <Glyph name={glyph} />
      <span className="sr">{word}: </span>
    </span>
  );
}

/** One row for each step measured: when, the requests, the errors and p99 with their verdicts, and the journeys. */
function Steps({ r }: { r: Release }) {
  if (!r.measured.length) return <p className="rel-end">No step was measured.</p>;
  if (r.dryRun)
    return (
      <p className="rel-end">
        The dry run recorded the {r.measured.map((m) => `${m.weight}%`).join(' and ')}{' '}
        {r.measured.length === 1 ? 'step' : 'steps'}, and measured nothing.
      </p>
    );
  return (
    <>
      <table className="measures ship">
        <thead>
          <tr>
            <th className="label">Step</th>
            <th className="label opt">Measured</th>
            <th className="label opt">Requests</th>
            <th className="label">Errors</th>
            <th className="label">p99</th>
            <th className="label">Journeys</th>
          </tr>
        </thead>
        <tbody>
          {r.measured.map((m) => {
            const journeys = m.stepped.figures?.canary.journeys;
            return (
              <tr key={m.weight}>
                <td className="mono">{m.weight}%</td>
                <td className="mono opt">{clockSeconds(m.at)}</td>
                <td className="mono opt">
                  <Pair r={r} m={m} name="enough-requests" />
                </td>
                <td className="mono">
                  <Mark phase={phaseOf(r, m, 'errors')} />
                  <Pair r={r} m={m} name="errors" />
                </td>
                <td className="mono">
                  <Mark phase={phaseOf(r, m, 'latency')} />
                  <Pair r={r} m={m} name="latency" />
                </td>
                <td className="mono">
                  {journeys && !r.dryRun ? (
                    <Pair r={r} m={m} name="journeys" />
                  ) : (
                    <Verdict phase={phaseOf(r, m, 'journeys')} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="help">Each figure on the canary, with the baseline’s under it.</p>
    </>
  );
}

/** How the release ended, or where it is now, and any earlier attempt a retry replaced. */
function Ending({ r }: { r: Release }) {
  const { end } = r;
  const before = r.retried.map((e) => `${endedAt(e)} at ${clockSeconds(e.at)}`).join(', then ');
  return (
    <>
      <p className="rel-end">
        {before && `Retried after it was ${before}. `}
        {!end
          ? `On the canary at ${r.weight}% now${r.until ? `; this step ends at ${clockSeconds(r.until)}` : ''}.`
          : end.kind === 'promoted'
            ? `Promoted at ${clockSeconds(end.at)}, ${duration(end.at - r.startedAt)} after it started.`
            : end.kind === 'aborted' && end.by === 'stop'
              ? `Stopped with the line at ${end.weight}% at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic, and the release stays stopped until Martin retries it or a new deploy starts another.`
              : end.kind === 'aborted'
                ? `Aborted by Martin at ${end.weight}% at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic, and the release stays aborted until he retries it or a new deploy starts another.`
                : end.kind === 'errored'
                  ? `Stopped by an analysis error at ${end.weight}% at ${clockSeconds(end.at)}: the analysis could not judge the canary, so nothing failed and it is no signal. ${shortVersion(r.previous)}, the version before, takes all the traffic, and the release stays stopped until Martin retries it or a new deploy starts another.`
                  : end.by === 'martin'
                    ? `Rolled back at ${end.weight}% at ${clockSeconds(end.at)}: Martin aborted it after the analysis judged it bad, which counts as a rollback. ${100 - end.weight}% of the traffic never saw it.`
                    : `Rolled back at ${end.weight}% at ${clockSeconds(end.at)}. ${100 - end.weight}% of the traffic never saw it.`}
        {r.dryRun &&
          ' The dry run answers for it: its merge was never made, so nothing shipped and nothing was measured.'}
      </p>
      {(end?.kind === 'rolled-back' || end?.kind === 'errored') && <p className="words">{end.reason}</p>}
    </>
  );
}

/** What Verify found: the sense, its outcome, its words, and every page against the version before. */
function Verify({ v }: { v: Verified }) {
  const [word, tone, glyph] =
    v.outcome === 'cleared'
      ? (['Cleared', 'ok', 'check'] as const)
      : v.held
        ? (['Persists again · held for Martin', 'attn', 'cross'] as const)
        : (['Persists · back to Plan', 'signal', 'cross'] as const);
  const note = marksNote(v);
  return (
    <div className="verify">
      <div className="rel-head">
        <span className="label">
          Verify · {v.sense ? SENSE[v.sense].the : 'the sense'} · {v.check}
        </span>
        <span className={`v tone-${v.dryRun ? 'faint' : tone}`}>
          <Glyph name={glyph} />
          {word}
          {v.dryRun && ', as the dry run records it'}
        </span>
      </div>
      <p className="words">{v.words}</p>
      <p className="rel-facts">
        {clock(v.at)}
        {v.version && (
          <>
            {' '}
            · on <b>{shortVersion(v.version)}</b>
          </>
        )}
        {v.outcome === 'persists' &&
          !v.held &&
          ' · the work went back to Plan with this as evidence; a second time, it holds for Martin'}
      </p>
      {v.pages.length > 0 && (
        <div className="regress">
          <span className="label">Every page against {shortVersion(v.against)}, the version before</span>
          <div className="row">
            {v.pages.map((page) => {
              // A page another work item the release carried meant to change says whose change it is.
              const kind = page.intended
                ? 'intended'
                : page.intendedFor
                  ? 'theirs'
                  : page.changed > 0
                    ? 'changed'
                    : 'same';
              return (
                <figure key={page.page}>
                  <div className="vis">{page.screenshot && <Shot shot={page.screenshot} />}</div>
                  <figcaption>
                    <span>{page.page}</span>
                    <span className={`mono change ${kind}`}>
                      {percent(page.changed)} · {kind === 'theirs' ? `intended for #${page.intendedFor}` : kind}
                    </span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      )}
      {/* Said even with no pages: a sense that looks at none compares none. */}
      {note && <p className="help">{note}</p>}
    </div>
  );
}
