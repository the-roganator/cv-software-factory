/**
 * Guardrails' sheet: spec 6's eleven as a checklist, whole, for everyone, opened from its summary in the bottom row
 * (`Summaries.tsx`), from Controls, or at a row by the address (`?open=`). Its kicker says how many hold; each row is
 * one line and a button, Held or Did not hold, the guardrail's number and name, and how old its last proof is, in two
 * columns from 1180 up and one below. One row opens at a time, in place under it, with `aria-expanded`: what holds it,
 * its last proof, what it refused in the last seven days, and, for the five a red-team attack proves, that attack with
 * its last run and Launch (`projection/guardrails.ts` and `projection/refusals.ts` read each from the events).
 *
 * Its refusals are the last three, a line each: when, the mechanism in `attn` mono, what was refused in a few words,
 * and its work item, which opens its sheet, or the audit log where it has none. Their own words are on the work item,
 * not here. A relayed refusal whose signature does not check out says so, and is not counted; one whose public words
 * are redacted says that the line checked it when it was recorded. Where nothing refused, the row says None; the
 * row the last rollback proves says what that rollback was, and that auto-rollback is off while it is.
 *
 * Launch opens the attack's dialog (`AttackDialog.tsx`, which arrives when it first opens). Attacks run one at a time:
 * while one is in flight its Launch reads Running and every other is dashed and disabled, saying which is running. For
 * a visitor, Launch is a label, which opens the same dialog read-only: what the attack does, and that Martin launches
 * it, with only Close. An attack not available yet has no Launch at all, for anyone: its card says so, with what it
 * tries.
 */
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { Admin } from '../admin.ts';
import { ago, clock, count, shortVersion, shortWhen, startOfDay } from '../format.ts';
import {
  type AttackRow,
  type GuardrailRow,
  type GuardrailsView,
  MECHANISM_WORDS,
  type ProofResult,
  type ProofSource,
  type RefusalLine,
  type Standing,
} from '../projection/index.ts';
import { Glyph, type GlyphName } from './Glyph.tsx';
import { heldWords, LAST_RUN, READS } from './panel-words.ts';
import { bringIntoSheet, SheetFrame } from './SheetFrame.tsx';
import '../styles/guardrails.css';

/** The attack's dialog, which a press of Launch opens: its code arrives then. */
const AttackDialog = lazy(() => import('./AttackDialog.tsx').then((module) => ({ default: module.AttackDialog })));

/** A proof of `make guardrails` that is more than its command, in a few words. */
const PROOF_WORDS: Record<string, string> = {
  'stop-the-line': 'the stop-the-line drill',
  rollback: 'the last rollback',
};

/** Where a proof came from, in words: `make guardrails`, the tests in CI on main at a commit, or an attack. */
function From({ source, onOpen }: { source: ProofSource; onOpen: (item: string) => void }) {
  if (source.kind === 'attack') {
    return (
      <>
        attack{' '}
        <button type="button" className="linkish" onClick={() => onOpen(source.workItem)}>
          #{source.workItem}
        </button>
      </>
    );
  }
  if (source.kind === 'ci') {
    return (
      <>
        tests in CI on main ·{' '}
        <a className="mono" href={source.url}>
          {source.commit.slice(0, 7)}
        </a>
      </>
    );
  }
  const words = PROOF_WORDS[source.proof];
  return (
    <>
      <code>make guardrails</code>
      {words && ` · ${words}`}
    </>
  );
}

/** What a proof that did not hold let through, and that it pages Martin, until the same proof holds again. */
function DidNotHold({ proof }: { proof: ProofResult }) {
  const { source } = proof;
  const what =
    source.kind === 'attack'
      ? source.verdict === 'not-refused'
        ? `Attack #${source.workItem} was not refused: something it tried got through, as its own record shows on its card. Its end, at ${clock(proof.at)}, pages Martin.`
        : `Attack #${source.workItem} was recorded as refused, but its refusals do not bear that out: ${source.why ?? 'they are not the ones it expects'}. That pages Martin.`
      : `Its ${source.kind === 'ci' ? 'tests in CI on main' : 'proof'} did not hold, at ${clock(proof.at)}: ${proof.output ?? 'its output is on the record'}. That pages Martin.`;
  return (
    <p className="attn">
      {what} It reads as not held until {source.kind === 'attack' ? 'its attack' : 'the same proof'} holds again.
    </p>
  );
}

/** A time on the page's day as its clock, and on another with its weekday: "13:30", "Fri 18:40". */
const at = (t: number, now: number) => (startOfDay(t) === startOfDay(now) ? clock(t) : shortWhen(t));

/** What a refusal's line says of it beside its words, by how it stands: nothing for one that counts. */
const STANDING: Record<Exclude<Standing, 'counted'>, [words: string, tone: string]> = {
  redacted: ['Redacted in public: the line checked its signature when it was recorded.', ''],
  unverified: ['Unverified: its signature does not check out, so it is not counted.', 'tone-attn'],
  checking: ['Checking its signature.', ''],
};

/** One refusal: when, its mechanism, what was refused, and where it is. */
function Refusal({ line, now, onOpen }: { line: RefusalLine; now: number; onOpen: (item: string) => void }) {
  const said = line.standing === 'counted' ? undefined : STANDING[line.standing];
  return (
    <li>
      <span className="mono">{at(line.at, now)}</span>
      <span>
        <span className="mech">{MECHANISM_WORDS[line.mechanism]}</span>
        {line.action}
        {line.count > 1 && <span className="times"> · {count(line.count)} times</span>}
        {said && <small className={said[1] || undefined}>{said[0]}</small>}
      </span>
      {line.workItem ? (
        <button type="button" className="linkish go" onClick={() => onOpen(line.workItem ?? '')}>
          #{line.workItem}
        </button>
      ) : (
        <a className="go" href="?view=audit">
          Audit log
        </a>
      )}
    </li>
  );
}

/** What proves a guardrail the last rollback proves, where nothing refuses: that rollback, and the switch. */
function rollbackWords({ last, autoRollback }: NonNullable<GuardrailRow['rollback']>, now: number): string {
  const was = last
    ? `The last rollback: ${shortVersion(last.version)}, ${startOfDay(last.at) === startOfDay(now) ? 'at ' : ''}${at(last.at, now)}, ${last.by === 'martin' ? 'by Martin, aborting a canary the analysis judged bad' : 'by its analysis'}.`
    : 'No rollback yet.';
  return autoRollback ? was : `${was} Auto-rollback is off, by Martin: a canary judged bad waits for him.`;
}

/** A row's refusals in the last seven days, and how many count. */
function Refusals({ row, now, onOpen }: { row: GuardrailRow; now: number; onOpen: (item: string) => void }) {
  const { lines, counted, unverified } = row.refusals;
  return (
    <div>
      <span className="label">
        Refusals · 7 days{counted > 0 && ` · ${count(counted)}`}
        {unverified > 0 && ` · ${count(unverified)} unverified`}
      </span>
      {lines.length > 0 ? (
        <ul className="reflist">
          {lines.map((line) => (
            <Refusal key={line.seq} line={line} now={now} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        !row.rollback && <p>None.</p>
      )}
      {row.rollback && <p className="instead">{rollbackWords(row.rollback, now)}</p>}
    </div>
  );
}

/** An attack, in its guardrail's opened row: its name, its last run, and Launch. */
function Attack({
  row,
  running,
  martin,
  now,
  onLaunch,
  onOpen,
}: {
  row: AttackRow;
  running: GuardrailsView['running'];
  martin: boolean;
  now: number;
  onLaunch: () => void;
  onOpen: (item: string) => void;
}) {
  const { last } = row;
  if (!row.available) {
    // Held back for now (`available` in `policy/attacks.ts`): what it tries, said here as the dialog would, and no
    // Launch, for Martin or anyone, until policy makes it available.
    return (
      <div>
        <span className="label">Its attack</span>
        <div className="gr-attack unavailable">
          <b>{row.name}</b>
          <p className="last">
            <span className="v tone-faint">
              <Glyph name="dash" />
              Not available yet
            </span>
          </p>
          <p className="help tries">{row.tries}</p>
        </div>
      </div>
    );
  }
  const mine = running?.attack === row.attack;
  const [word, tone, glyph]: [string, string, GlyphName] = last
    ? LAST_RUN[last.verdict]
    : ['Not launched yet', 'faint', 'dash'];
  const failed = last && last.verdict !== 'refused' && last.verdict !== 'running';
  return (
    <div>
      <span className="label">Its attack</span>
      <div className={failed ? 'gr-attack failed' : 'gr-attack'}>
        <b>{row.name}</b>
        {martin ? (
          <button type="button" className="btn" disabled={running !== undefined} onClick={onLaunch}>
            {mine ? 'Running' : 'Launch'}
          </button>
        ) : (
          // A visitor's Launch is a label, as every control of Martin's is for a visitor; pressed, it says what the
          // attack does, and that Martin launches it.
          <button type="button" className="ro" aria-haspopup="dialog" onClick={onLaunch}>
            Launch
          </button>
        )}
        <p className="last">
          <span className={`v tone-${tone}`}>
            <Glyph name={glyph} />
            {word}
          </span>
          {last && <span>{ago(last.at, now)}</span>}
          {last && (
            <button type="button" className="linkish" onClick={() => onOpen(last.workItem)}>
              #{last.workItem}
            </button>
          )}
        </p>
      </div>
      {martin && running && (
        <p className="help gr-busy">
          {mine ? 'Running' : `One at a time: #${running.workItem} is running`}, until it ends or {clock(running.until)}
          , when it counts as unfinished.
        </p>
      )}
    </div>
  );
}

function Row({
  row,
  open,
  onToggle,
  view,
  martin,
  now,
  onLaunch,
  onOpen,
}: {
  row: GuardrailRow;
  open: boolean;
  onToggle: () => void;
  view: GuardrailsView;
  martin: boolean;
  now: number;
  onLaunch: (row: GuardrailRow) => void;
  onOpen: (item: string) => void;
}) {
  const id = useId();
  const [word, tone, glyph] = READS[row.state];
  const { proof } = row;
  return (
    <div className={row.state === 'not-held' ? 'gr failed' : 'gr'}>
      <button type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
        <span className={`v tone-${tone}`}>
          <Glyph name={glyph} />
          {word}
        </span>
        <span className="n">{row.n}</span>
        <span className="name">{row.name}</span>
        <span className="age">{proof ? ago(proof.at, now) : 'never'}</span>
        <Glyph name="right" className="glyph chev" />
      </button>
      {open && (
        <div className="more" id={id}>
          <p>{row.mechanism}</p>
          {row.state === 'not-held' && proof && <DidNotHold proof={proof} />}
          <p>
            <span className="label">Last proof</span>
            {proof ? (
              <>
                {proof.held ? 'Held' : <span className="tone-attn">Did not hold</span>}:{' '}
                <From source={proof.source} onOpen={onOpen} />, {ago(proof.at, now)}.
              </>
            ) : row.attack?.available ? (
              'None yet: its attack, or make guardrails, proves it.'
            ) : (
              'None yet: make guardrails proves it.'
            )}
          </p>
          <Refusals row={row} now={now} onOpen={onOpen} />
          {row.attack && (
            <Attack
              row={row.attack}
              running={view.running}
              martin={martin}
              now={now}
              onLaunch={() => onLaunch(row)}
              onOpen={onOpen}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function GuardrailsSheet({
  view,
  now,
  admin,
  row: asked,
  onOpen,
  motion,
  rise,
  onClose,
}: {
  view: GuardrailsView;
  /** The page's time, which each proof's age counts from. */
  now: number;
  admin: Admin;
  /** The guardrail it opens at, opened, scrolled to and focused; none opens it at its top. */
  row: number | undefined;
  /** Opens a work item's sheet, in this one's place. */
  onOpen: (item: string) => void;
  motion: boolean;
  rise: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<number | undefined>(asked);
  const [launching, setLaunching] = useState<GuardrailRow | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const martin = admin.kind === 'martin';
  // The row it was opened at comes into view, focused, as the sheet opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the sheet opens
  useEffect(() => {
    if (asked !== undefined)
      bringIntoSheet(list.current?.querySelector<HTMLElement>('.gr > button[aria-expanded="true"]'));
  }, []);
  const row = (each: GuardrailRow) => (
    <Row
      key={each.n}
      row={each}
      open={open === each.n}
      onToggle={() => setOpen(open === each.n ? undefined : each.n)}
      view={view}
      martin={martin}
      now={now}
      onLaunch={setLaunching}
      onOpen={onOpen}
    />
  );
  return (
    <SheetFrame
      kicker={
        <span className={view.notHeld ? 'label panel-count tone-attn' : 'label panel-count'}>
          {heldWords(view)}
          {!martin && ' · Read only'}
        </span>
      }
      title="Guardrails"
      motion={motion}
      rise={rise}
      onClose={onClose}
    >
      <div className="wrap sheet-whole">
        <section className="guardrails" id="guardrails" aria-labelledby="sheet-title">
          <p className="help">
            Each is held by a mechanism, not an instruction, and proved. Open one for what holds it, its last proof, its
            refusals and its attack.
          </p>
          <div className="gr-list" ref={list}>
            <div className="gr-col">{view.rows.slice(0, 6).map(row)}</div>
            <div className="gr-col">{view.rows.slice(6).map(row)}</div>
          </div>
          <p className="help">Only auto-rollback can be switched off, in Controls. Stop the line always works.</p>
          {launching?.attack?.available && (
            <Suspense fallback={null}>
              <AttackDialog
                guardrail={launching.n}
                attack={launching.attack.attack}
                running={view.running}
                admin={admin}
                onClose={() => setLaunching(undefined)}
              />
            </Suspense>
          )}
        </section>
      </div>
    </SheetFrame>
  );
}
