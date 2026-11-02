/**
 * An improvement's flag on its sheet, in place of Release and Verify: the flag's name and the stage it is at, in the
 * stages' words, its slider, and a block per stage it reached, newest first, the older ones folded, each drawn as a
 * release's block is. The slider is Controls' own: Martin sets a stage here as there, through the same confirmation,
 * and a visitor's is read-only.
 *
 * What Verify finds at each stage comes in its own events: at Checks, the journeys' result with the flag on, against
 * a run with it off, and the probes' pictures of the pages off and on, in light and dark, with where they differ; at
 * Preview, the same, and what the device check found when a probe asked for the preview (`flag.checked`); at Share, its
 * comparison of the two sides (`flag.compared`). Until Verify has judged, a block says what it waits for.
 */
import { Suspense, useState } from 'react';
import type { Admin } from '../admin.ts';
import { changedShare, clock, lower, shortVersion, shortWhen } from '../format.ts';
import { previewHref } from '../profile.ts';
import {
  blockWord,
  byWords,
  type Checked,
  checkWords,
  comparedWords,
  type FlagBlock,
  type FlagSheet,
  type FlagStage,
  STAGE_NAME,
  shotOf,
  stageSays,
} from '../projection/index.ts';
import { msCell, shareCell } from '../projection/release.ts';
import { FlagDialog, FlagSlider, stageWords } from './Flags.tsx';
import { Shot } from './Pictures.tsx';

/**
 * The pages a check pictured, each side by side with the flag off and on, and where they differ when they do: a row for
 * each page in each colour scheme, light then dark, as the check took them, for Martin to judge, since no probe knows a
 * new feature.
 */
function CheckedPages({ checked }: { checked: Checked & { stage: 'checks' } }) {
  return (
    <div className="regress flag-pages">
      <span className="label">The pages, the flag off and on, in light and dark</span>
      {checked.pages.map((page) => {
        const off = shotOf(checked, page.off);
        const on = shotOf(checked, page.on);
        const diff = shotOf(checked, page.diff);
        return (
          <div className={`row ${diff ? 'trio' : 'pair'}`} key={`${page.page} ${page.scheme}`}>
            <figure>
              <div className="vis">
                {off ? (
                  <Shot shot={off} />
                ) : (
                  <div className="shot-missing">
                    <span className="label">No picture with it off</span>
                    <span>No run with the flag off was taken before it went on.</span>
                  </div>
                )}
              </div>
              <figcaption>
                <span>
                  {page.page} · {page.scheme}
                </span>
                <span className="mono">flag off{off && ` · ${shortVersion(off.version)}`}</span>
              </figcaption>
            </figure>
            <figure>
              <div className="vis">
                {on ? (
                  <Shot shot={on} />
                ) : (
                  <div className="shot-missing">
                    <span className="label">Screenshot unavailable</span>
                    <span>The event names a picture with the flag on that it does not carry.</span>
                  </div>
                )}
              </div>
              <figcaption>
                <span>
                  {page.page} · {page.scheme}
                </span>
                <span className={`mono change ${page.changed ? 'changed' : 'same'}`}>
                  flag on ·{' '}
                  {page.changed === undefined
                    ? 'not compared'
                    : page.changed
                      ? `${changedShare(page.changed)} changed`
                      : 'the same'}
                </span>
              </figcaption>
            </figure>
            {diff && (
              <figure>
                <div className="vis">
                  <Shot
                    shot={diff}
                    alt={`Where ${page.page}, in ${page.scheme}, differs with the flag on, marked on the page`}
                  />
                </div>
                <figcaption>
                  <span>
                    {page.page} · {page.scheme}
                  </span>
                  <span className="mono">where they differ</span>
                </figcaption>
              </figure>
            )}
          </div>
        );
      })}
      <p className="help">
        The probes are written from the spec, blind, and know no new feature: these pictures are for Martin to judge
        when he widens. The spec’s criteria were proved by the pull request’s own tests, with the flag on and off.
      </p>
    </div>
  );
}

/** Flags set by hand outside every stage that a move's write dropped, and so turned off, in a sentence. */
function Dropped({ block }: { block: FlagBlock }) {
  if (block.kind !== 'staged' || !block.dropped.length) return null;
  const names = block.dropped.join(', ');
  return (
    <p className="rel-end">
      The write also dropped {block.dropped.length === 1 ? 'a flag' : 'flags'} set by hand outside every stage, which
      turned {block.dropped.length === 1 ? 'it' : 'them'} off: <code className="flagname">{names}</code>.
    </p>
  );
}

function Body({ block, flag, app }: { block: FlagBlock; flag: FlagSheet; app: string | undefined }) {
  const { row } = flag;
  if (block.kind === 'released') {
    return (
      <p className="rel-end">
        Shipped in {shortVersion(block.version)} with the flag off, so nobody saw a change: release {block.release},
        promoted at {clock(block.at)}. The flag waited for Martin to widen it.
      </p>
    );
  }
  const { stage } = block;
  switch (stage.stage) {
    case 'off':
      return (
        <>
          {block.reason && <p className="words">“{block.reason}”</p>}
          <p className="rel-end">
            {byWords(block)}, for everyone, a preview too. The admin service asks the app for the flags it holds, and
            tells his phone if it hasn’t taken it within a minute.{' '}
            {row.backOn
              ? 'It was on for everyone, so it can go straight back, from its slider.'
              : `Its code stays in the app, off, and nothing was rolled back. To try again, Martin asks with the “+”.`}
          </p>
        </>
      );
    case 'checks': {
      const { checked } = block;
      return (
        <>
          <p className="rel-end">
            {byWords(block)}. On for the factory’s own checks, by the header only they can send.{' '}
            {checkWords(block, 'Preview and Share')}
          </p>
          {checked?.stage === 'checks' && checked.pages.length > 0 && <CheckedPages checked={checked} />}
        </>
      );
    }
    case 'preview': {
      const device = block.checked?.stage === 'preview' ? block.checked.device : undefined;
      return (
        <>
          <p className="rel-end">
            {byWords(block)}. Also on for anyone who asks to preview it, in their own browser.{' '}
            {checkWords(block, 'Share')}
          </p>
          {device && (
            <p className="words">
              A probe asked for the preview. Allowed: {device.allowed.length ? device.allowed.join(', ') : 'none'} ·
              kept besides: {device.kept.length ? device.kept.join(', ') : 'nothing'}
            </p>
          )}
          {block.current && app && !row.turnedOff && (
            <p className="rel-end">
              <a href={previewHref(app, row.name, row.page)} target="_blank" rel="noopener">
                Preview it on the app<span aria-hidden="true"> ↗</span>
                <span className="sr"> (opens a new tab)</span>
              </a>
              : it sets the same cookie in your browser, for a day, and shows you only this flag.
            </p>
          )}
        </>
      );
    }
    case 'share': {
      const { compared } = block;
      return (
        <>
          <p className="rel-end">
            {byWords(block)}. Also on for {stage.share}% of the traffic generator’s requests. Verify compares the two
            sides from the generator’s own figures, by the id each request carried, and works out each id’s side with
            flagd’s own rule: the app labels nothing it is judged on.
          </p>
          {compared && (
            <table className="measures figs">
              <thead>
                <tr>
                  <th className="label">Measure</th>
                  <th className="label num">Flag on</th>
                  <th className="label num base">Flag off</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Requests</td>
                  <td className="num">{compared.sides.on.requests}</td>
                  <td className="num base">{compared.sides.off.requests}</td>
                </tr>
                <tr>
                  <td>
                    Errors<small>share of 5xx answers</small>
                  </td>
                  <td className="num">{shareCell(compared.sides.on.errorRate)}</td>
                  <td className="num base">{shareCell(compared.sides.off.errorRate)}</td>
                </tr>
                <tr>
                  <td>
                    Latency<small>p99</small>
                  </td>
                  <td className="num">{msCell(compared.sides.on.p99Ms)}</td>
                  <td className="num base">{msCell(compared.sides.off.p99Ms)}</td>
                </tr>
              </tbody>
            </table>
          )}
          <p className="rel-end">
            {compared
              ? `Judged at ${clock(compared.at)}, with the canary’s thresholds: ${comparedWords(compared)}.${compared.reason ? ` ${compared.reason}` : ''}${compared.setAsideMinutes ? ` ${compared.setAsideMinutes} minutes a canary was in flight are set aside: its two versions would mix the sides.` : ''}`
              : block.current
                ? 'Verify judges once each side has enough requests. Everyone can be taken once the comparison has passed.'
                : 'Moved on before Verify had judged it.'}
          </p>
        </>
      );
    }
    case 'everyone':
      return (
        <p className="rel-end">
          {byWords(block)}. On for every visitor. Turning it off is still one press, on its slider, and reaches the app
          in seconds, with no deploy.
        </p>
      );
  }
}

function Block({
  block,
  flag,
  app,
  folded,
}: {
  block: FlagBlock;
  flag: FlagSheet;
  app: string | undefined;
  folded: boolean;
}) {
  const [word, tone] = blockWord(block);
  const label =
    block.kind === 'released'
      ? `Released · ${shortVersion(block.version)}`
      : block.stage.stage === 'share'
        ? `Share · ${block.stage.share}%`
        : STAGE_NAME[block.stage.stage];
  const head = (
    <>
      <span className="label">
        {label} · {shortWhen(block.at)}
      </span>
      <span className={`out tone-${tone}`}>
        <span className="dot" aria-hidden="true" />
        {word}
      </span>
    </>
  );
  if (folded)
    return (
      <details className="rel raised">
        <summary className="rel-head">
          {head}
          <span className="more">Show this stage</span>
        </summary>
        <Body block={block} flag={flag} app={app} />
        <Dropped block={block} />
      </details>
    );
  return (
    <article className="rel raised">
      <div className="rel-head">{head}</div>
      <Body block={block} flag={flag} app={app} />
      <Dropped block={block} />
    </article>
  );
}

export function FlagSection({
  flag,
  app,
  admin,
  onMoved,
}: {
  flag: FlagSheet;
  app: string | undefined;
  admin: Admin;
  onMoved: () => void;
}) {
  const { row } = flag;
  const [choosing, setChoosing] = useState<FlagStage | undefined>(undefined);
  return (
    <section className="sec">
      <h3>The flag</h3>
      <p className="help">
        <code className="flagname">{row.name}</code>{' '}
        {row.turnedOff
          ? `is off, turned off by Martin.`
          : `is at ${stageWords(row.stage)}: ${lower(stageSays(row.stage))}`}{' '}
        Each stage is Martin’s, here or in Controls; widening asks for his passkey.
      </p>
      <FlagSlider row={row} onChoose={admin.kind === 'martin' ? (stop) => setChoosing(stop.to) : undefined} />
      {/* As in Controls, a flag closed meanwhile takes its confirmation with it: no move is left to make. */}
      {choosing && admin.kind === 'martin' && !row.closed && (
        <Suspense fallback={null}>
          <FlagDialog
            row={row}
            to={choosing}
            token={admin.session.token}
            onClose={() => setChoosing(undefined)}
            onMoved={onMoved}
          />
        </Suspense>
      )}
      <div className="rels">
        {flag.blocks.map((block, i) => (
          <Block key={`${block.kind}-${block.at}`} block={block} flag={flag} app={app} folded={i > 0} />
        ))}
      </div>
      <p className="source">
        <span>
          Martin’s stages, as the admin service records each move; Verify’s checks with the probes at Checks and
          Preview, their pictures Playwright screenshots; and its comparisons at Share.
        </span>
      </p>
    </section>
  );
}
