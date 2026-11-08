/**
 * Needs you, the left of the bottom row: one card per hold, the line's and triage's, oldest first, so what has waited
 * longest is on top. Each says what the hold is, shows the one piece of evidence that explains it, and lists each
 * answer it takes beside what that answer does, from the line's own table. The buttons are all outlined: the console
 * does not suggest an answer. A merge or a deploy, which Martin ends on GitHub, heads its answers with the way there:
 * "Merge", "Deploy" or "Review" and GitHub's mark, a button as wide as the others and bolder, since it is the way
 * forward and the answers are the ways back, with what it does beside it. Under the cards, Martin's answers today.
 *
 * For Martin, each answer is a write to the admin service, naming the hold the card showed, so the service answers
 * that hold or none. Approving a guardrail's hold asks for his passkey again (the key shows while it is not fresh);
 * the service decides, from the stored hold. An answered card moves to Answered today as its event arrives: there is
 * no toast. A visitor sees the same cards, titled Waiting on Martin, each answer a label beside what it does.
 *
 * A canary paused for Martin (auto-rollback off, judged bad) has a card among them (`CanaryCard`), one for the release,
 * whatever work items it carries: the analysis's words, what it judged bad, and the Canary panel's own controls,
 * Promote fully with the key and Abort, which counts as a rollback.
 *
 * A flag waiting for Martin to widen it has a card among them (`FlagCard`): Widen to the next stage, dashed with its
 * reason when it can't be taken now, and Turn off, each opening the slider's confirmation (`Flags.tsx`).
 *
 * A work item's sheet heads with the same cards for it (`WaitsOnMartin`), drawn by the same components, so answering
 * there is answering here; only the title, which the sheet has already, and "Open the work item" are left off.
 */
import { type HoldAnswer, MARTIN_ANSWER_CHARS } from '@software-factory/events';
import { Fragment, type ReactNode, Suspense, useEffect, useId, useRef, useState } from 'react';
import { STAGE_NAME as STATION_NAME } from '../../../../../docs/design/system/station.ts';
import { FLAG_STEP_UP } from '../access.ts';
import type { Admin } from '../admin.ts';
import { clock, inWords, shortVersion } from '../format.ts';
import { previewHref } from '../profile.ts';
import {
  type CanaryNeed,
  type FlagNeed,
  type FlagRow,
  type FlagStage,
  type FlagsView,
  type Move,
  type Need,
  type NeedsView,
  SAMPLE_PULL,
  STAGE_NAME,
  type WayThere,
} from '../projection/index.ts';
import { CanaryAnswers } from './Canary.tsx';
import { FlagDialog, stageWords } from './Flags.tsx';
import { ToolMark } from './Logos.tsx';
import { Shot } from './Pictures.tsx';
import { Key, useStepUp } from './StepUp.tsx';
import { ReasonField, Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

const ROUTE = { approved: 'approve', rejected: 'reject', answered: 'answer', replanned: 'replan' } as const;

/** What the field of each answer that goes with words (`WORDED_ANSWERS`) asks for, as its placeholder. */
const ASKS: Partial<Record<HoldAnswer, string>> = {
  answered: 'What the line should know',
  replanned: 'What the planner should change in the spec',
};

function Evidence({ need, martin }: { need: Need; martin: boolean }) {
  const { evidence, link, note } = need;
  return (
    <>
      {evidence.kind === 'gate' ? (
        <GateEvidence evidence={evidence} martin={martin} />
      ) : evidence.kind === 'output' ? (
        <p className="words">
          {evidence.heading}
          {'\n'}
          {evidence.text}
        </p>
      ) : evidence.kind === 'question' ? (
        <p className="ev">
          {evidence.before} <q>{evidence.question}</q>
        </p>
      ) : evidence.kind === 'spec' ? (
        <SpecEvidence evidence={evidence} />
      ) : evidence.kind === 'needs' ? (
        <NeedsEvidence evidence={evidence} />
      ) : (
        <p className="ev">{evidence.text}</p>
      )}
      {note && <p className="ev">{note}</p>}
      {link && (
        <p className="ev">
          <a href={link.href}>{link.label}</a>
        </p>
      )}
    </>
  );
}

/** A mark on the station face: drawn, and said to a screen reader in words. */
const Mark = ({ glyph, said }: { glyph: string; said: string }) => (
  <>
    <span aria-hidden="true">{glyph}</span>
    <span className="sr">{said}</span>
  </>
);

/**
 * The review gate's hold of a merge for its risk tags, on the station face, as its summary says it: a cross on the
 * check and on each tag, with what in the diff gave it, the tags names lined up; a tick on what it found clear; and
 * what it waits for. Then that approving is Martin's own review of that head, on GitHub, which a push undoes.
 */
function GateEvidence({
  evidence,
  martin,
}: {
  evidence: Extract<Need['evidence'], { kind: 'gate' }>;
  martin: boolean;
}) {
  const { said, tags, clear, head, approving } = evidence;
  const width = Math.max(0, ...tags.map(({ tag }) => tag.length));
  const at = head.slice(0, 7);
  return (
    <>
      <p className="words">
        <span className="x">
          <Mark glyph="✕ " said="Held: " />
          review
        </span>
        {said && ` · ${said}`}
        {tags.map(({ tag, because }) => (
          <Fragment key={tag}>
            {'\n'}
            <span className="x">
              <Mark glyph="✕ " said="Risk tag: " />
              {tag}
            </span>
            {' '.repeat(width - tag.length + 2)}
            {because}
          </Fragment>
        ))}
        {clear.map((line) => (
          <Fragment key={line}>
            {'\n'}
            <Mark glyph="✓ " said="Clear: " />
            {line}
          </Fragment>
        ))}
        {'\n'}
        <span aria-hidden="true">→ </span>
        {approving
          ? `waits for Martin’s approval of its head commit, ${at}`
          : `waits for Martin to approve its head commit, ${at}, and merge it`}
      </p>
      <p className="ev">
        Every other required check passed and the reviewer approved. Approving is {martin ? 'your' : 'Martin’s'} own
        review of its head commit, on GitHub: the console can’t give it. A push after{' '}
        {martin ? 'you approve needs you' : 'he approves needs him'} again.
      </p>
    </>
  );
}

const MERGED = 'The line goes on by itself once it merges.';
const RELEASED = 'Argo CD then starts its release, which ends this wait by itself.';

/**
 * What the way forward does, beside it: what Martin does on GitHub and what follows, in his voice when he is signed in
 * and a visitor's otherwise.
 */
const WAY_DOES: Record<WayThere, (n: number) => { martin: string; visitor: string }> = {
  merge: (n) => ({
    martin: `Opens #${n} on GitHub to merge it. ${MERGED}`,
    visitor: `Martin merges #${n} there. ${MERGED}`,
  }),
  conflict: (n) => ({
    martin: `Opens #${n} on GitHub, to put its conflict with main right and merge it. ${MERGED}`,
    visitor: `Martin puts #${n}’s conflict with main right there, and merges it. ${MERGED}`,
  }),
  queue: (n) => ({
    martin: `Opens #${n} on GitHub, to see why and merge it once it can. ${MERGED}`,
    visitor: `Martin sees why there, and merges #${n} once it can. ${MERGED}`,
  }),
  checks: (n) => ({
    martin: `Opens #${n} on GitHub, to merge it once its checks pass. ${RELEASED}`,
    visitor: `Martin merges #${n} there once its checks pass. ${RELEASED}`,
  }),
  deploy: (n) => ({
    martin: `Opens #${n} on GitHub to merge it. ${RELEASED}`,
    visitor: `Martin merges #${n} there. ${RELEASED}`,
  }),
  'deploy-queued': (n) => ({
    martin: `Opens #${n} on GitHub, in the merge queue, which merges it once its checks pass there. ${RELEASED}`,
    visitor: `The line added #${n} to the merge queue there, which merges it once its checks pass. ${RELEASED}`,
  }),
  'deploy-dequeued': (n) => ({
    martin: `Opens #${n} on GitHub, to see why the merge queue took it out and merge it once it can. ${RELEASED}`,
    visitor: `Martin sees why the merge queue took #${n} out there, and merges it once it can. ${RELEASED}`,
  }),
  approve: () => ({
    martin: 'Approve its head commit there: the review check then passes it, and the line adds it to the merge queue.',
    visitor: 'Martin approves its head commit there, with his own review, and the line adds it to the merge queue.',
  }),
  'approve-merge': () => ({
    martin: 'Approve its head commit there, then merge it there: the line does not add this one to the merge queue.',
    visitor: 'Martin approves its head commit there, with his own review, and merges it there.',
  }),
};

/**
 * The way a merge or a deploy ends, on GitHub, first among the answers: "Merge" or "Deploy", or "Review" for a merge
 * the review gate held for its risk tags, which Martin approves there with his own review of its head, as the console
 * can't. The verb and GitHub's mark, in the column of buttons and as wide as they are, bordered and weighted in the
 * text's colour, since it is the way forward and they are the ways back, with what it does beside it. The card names
 * the pull request already, so the words a reader hears add it and where it goes, the shown part being hidden from
 * them. A link, as it opens a page, in a tab of its own, so words half written on the card stay. A sample's pull
 * request never existed: the same look, not a link, with why beside it, muted.
 */
function WayForward({ way, martin }: { way: Need['way']; martin: boolean }) {
  if (!way) return null;
  const { verb, pullRequest, href } = way;
  // What shows is hidden from a screen reader, which hears the words in full instead, in a span of their own, so no
  // space between the two parts is left to layout.
  const shown = (
    <span className="way-words" aria-hidden="true">
      {verb}
      <ToolMark name="github" />
    </span>
  );
  if (href === undefined) {
    return (
      <div className="answer">
        <span className="btn small way">
          {shown}
          <span className="sr">
            {verb} #{pullRequest}
          </span>
        </span>
        <p className="nowhere">{SAMPLE_PULL}</p>
      </div>
    );
  }
  const does = WAY_DOES[way.there](pullRequest);
  return (
    <div className="answer">
      <a className="btn small way" href={href} target="_blank" rel="noopener">
        {shown}
        <span className="sr">
          {verb} #{pullRequest} on GitHub (opens GitHub in a new tab)
        </span>
      </a>
      <p>{martin ? does.martin : does.visitor}</p>
    </div>
  );
}

/**
 * The files a coder needs outside its scope, under the hold's reason: each with why, and those no scope may name
 * marked, since the reason, cut to fit, may not name them all.
 */
function NeedsEvidence({ evidence }: { evidence: Extract<Need['evidence'], { kind: 'needs' }> }) {
  return (
    <p className="words">
      {evidence.heading}
      {evidence.needs.map(({ path, reason, barred }) => (
        <Fragment key={path}>
          {'\n'}
          {path}
          {barred && <b className="barred"> · no scope may name it</b>}: {reason}
        </Fragment>
      ))}
    </p>
  );
}

/** An improvement's spec, as its card says it: the flag it names, the pages it changes, and its criteria. */
function SpecEvidence({ evidence }: { evidence: Extract<Need['evidence'], { kind: 'spec' }> }) {
  const { flag, pages, criteria } = evidence;
  const named: ReactNode[] = [
    ...(flag
      ? [
          <>
            its flag, <code className="flagname">{flag}</code>
          </>,
        ]
      : []),
    ...(pages.length
      ? [
          <>
            the {pages.length === 1 ? 'page' : 'pages'} it changes, <span className="mono">{pages.join(', ')}</span>
          </>,
        ]
      : []),
    inWords(criteria, 'acceptance criterion', 'acceptance criteria'),
  ];
  return (
    <p className="ev">
      The spec names{' '}
      {named.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence, in a fixed order
        <Fragment key={i}>
          {i === 0 ? '' : i === named.length - 1 ? ', and ' : ', '}
          {part}
        </Fragment>
      ))}
      {flag ? ', each tested with the flag on or off.' : '. It names no flag.'}
    </p>
  );
}

/**
 * Where a card stands: Needs you's own, titled, which opens the work item's sheet; or the sheet's (no `onOpen`), whose
 * title the sheet has already, named by its kicker.
 */
interface Placed {
  onOpen?: ((item: string) => void) | undefined;
}

/**
 * A card's foot: "Open the work item", in Needs you only, since the sheet is the work item; and, for a visitor, who
 * answers. Nothing, when it has neither.
 */
function Foot({ workItem, onOpen, martin }: { workItem: string | undefined; martin: boolean } & Placed) {
  if ((!onOpen || !workItem) && martin) return null;
  return (
    <div className="need-foot">
      {onOpen && workItem && (
        <button type="button" className="linkish" onClick={() => onOpen(workItem)}>
          Open the work item
        </button>
      )}
      {!martin && <span>Martin answers, signed in</span>}
    </div>
  );
}

/** A card, read only: each answer a label beside what it does, and who answers. */
function ReadOnlyCard({ need, onOpen }: { need: Need } & Placed) {
  const id = useId();
  return (
    <article className="need raised ruled" {...named(id, need.kicker, onOpen)}>
      <Kick need={need} />
      {onOpen && <h3 id={id}>{need.title}</h3>}
      <Evidence need={need} martin={false} />
      <div className="answers">
        <WayForward way={need.way} martin={false} />
        {need.answers.map((row) => (
          <div className="answer" key={row.answer}>
            <span className="ro">{row.label}</span>
            <p>{row.does}</p>
          </div>
        ))}
      </div>
      <Foot workItem={need.workItem} onOpen={onOpen} martin={false} />
    </article>
  );
}

/** What names a card: its title in Needs you, its kicker in the sheet. */
const named = (id: string, kicker: string, onOpen: Placed['onOpen']) =>
  onOpen ? { 'aria-labelledby': id } : { 'aria-label': kicker };

function Kick({ need }: { need: Need }) {
  return (
    <div className="kick">
      <b>{need.kicker}</b>
      <span>
        #{need.workItem} · {STATION_NAME[need.stage]} · {need.waited}
      </span>
    </div>
  );
}

/**
 * Martin's card: his answers, the words field of the one he opens, and what the service said if it refused. One field
 * is open at a time, and what he has written stays as he moves it from one answer to the other. On a work item a
 * visitor's report opened, answering in words shares them, with the passkey again, and the field says so.
 */
function MartinsCard({ need, token, onOpen }: { need: Need; token: string } & Placed) {
  const id = useId();
  const writes = useWrite(token);
  const { busy } = writes;
  const [writing, setWriting] = useState<HoldAnswer | undefined>(undefined);
  const [words, setWords] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // The field takes focus as it opens, so he can write at once.
  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);

  const send = async (answer: Need['answers'][number]) => {
    const shares = answer.share;
    const body = { hold: need.hold, ...(answer.words && { words: words.trim() }), ...(shares && { share: true }) };
    await writes.send(`/admin/holds/${need.workItem}/${ROUTE[answer.answer]}`, body, {
      passkey: answer.stepUp
        ? {
            title: `${shares ? 'Share your words on' : 'Approve'} #${need.workItem}`,
            what: answer.does,
            why: shares
              ? 'Sharing your words lets the agents read them, and makes them public'
              : need.cause === 'spec'
                ? 'Approving an improvement’s spec sets the line building something new'
                : 'Approving overrides a guardrail',
          }
        : undefined,
      // Answered: the card moves to Answered today as the event arrives, unless words left it held.
      done: () => {
        setWriting(undefined);
        setWords('');
        return undefined;
      },
    });
  };

  return (
    <article className="need raised ruled" {...named(id, need.kicker, onOpen)} aria-busy={busy || undefined}>
      <Kick need={need} />
      {onOpen && <h3 id={id}>{need.title}</h3>}
      <Evidence need={need} martin />
      <div className="answers">
        <WayForward way={need.way} martin />
        {need.answers.map((row) => (
          <div className="answer" key={row.answer}>
            {row.words ? (
              <button
                type="button"
                className="btn small"
                aria-expanded={writing === row.answer}
                aria-controls={`${id}-${row.answer}`}
                aria-disabled={busy || undefined}
                onClick={() => !busy && setWriting(writing === row.answer ? undefined : row.answer)}
              >
                {row.label}
                {row.stepUp && !writes.fresh && <Key />}
              </button>
            ) : (
              <button
                type="button"
                className="btn small"
                aria-disabled={busy || undefined}
                onClick={() => void send(row)}
              >
                {row.label}
                {row.stepUp && !writes.fresh && <Key />}
              </button>
            )}
            <p>{row.does}</p>
            {writing === row.answer && (
              <form
                className="words-form"
                id={`${id}-${row.answer}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (words.trim()) void send(row);
                }}
              >
                <ReasonField
                  id={`${id}-text`}
                  label={
                    row.answer === 'replanned'
                      ? `Why #${need.workItem} goes back to the planner`
                      : `Your answer to #${need.workItem}`
                  }
                  labelHidden
                  limit={MARTIN_ANSWER_CHARS}
                  rows={3}
                  value={words}
                  onChange={setWords}
                  placeholder={ASKS[row.answer] ?? ''}
                  help={
                    row.share
                      ? 'Here your words go to the agents and are public, so make sure they do not repeat the visitor.'
                      : need.aboutReport
                        ? 'Your words stay yours: a visitor’s report opened this, so no visitor and no agent reads them.'
                        : 'Visitors see your words, with anything shaped like a secret left out.'
                  }
                  field={field}
                >
                  <button
                    type="submit"
                    className="btn primary small"
                    disabled={!words.trim()}
                    aria-disabled={busy || undefined}
                  >
                    Send
                  </button>
                </ReasonField>
              </form>
            )}
          </div>
        ))}
      </div>
      <Refusal text={writes.refusal} />
      <Foot workItem={need.workItem} onOpen={onOpen} martin />
    </article>
  );
}

/**
 * A canary paused for Martin: what the analysis judged bad and by how much, in its own words on the station face, and
 * the Canary panel's own controls, Promote fully past its verdict and Abort, which counts as a rollback. One card for
 * the release, named by the first work item it carries, or by its version when it carries none.
 */
function CanaryCard({ need, admin, onOpen }: { need: CanaryNeed; admin: Admin } & Placed) {
  const id = useId();
  const martin = admin.kind === 'martin';
  const { release } = need;
  return (
    <article className="need raised ruled" {...named(id, need.kicker, onOpen)}>
      <div className="kick">
        <b>{need.kicker}</b>
        <span>
          {need.label} · Release · {release.weight}% · {need.waited}
        </span>
      </div>
      {onOpen && <h3 id={id}>{need.title}</h3>}
      {need.said.length > 0 && <p className="words">{need.said.join('\n')}</p>}
      <p className="ev">
        The analysis judged {shortVersion(release.version)} bad{need.bad && `: ${need.bad}`}. Auto-rollback was off when
        it was judged, so it waits for {martin ? 'you' : 'Martin'} instead of rolling back, even with auto-rollback
        switched on again. Stop the line still aborts it.
      </p>
      <CanaryAnswers r={release} admin={admin} />
      <Foot workItem={need.workItem} onOpen={onOpen} martin={martin} />
    </article>
  );
}

/** An answer to a flag's card: a button, dashed when it can't be taken now, or a visitor's label, beside what it does. */
function FlagAnswer({
  label,
  move,
  does,
  martin,
  onChoose,
}: {
  label: string;
  move: Move;
  does: string;
  martin: boolean;
  onChoose: () => void;
}) {
  const stepUp = useStepUp();
  const keyed = move.action !== undefined && FLAG_STEP_UP[move.action] && !move.refused && !stepUp.fresh;
  return (
    <div className="answer">
      {martin ? (
        <button
          type="button"
          className={`btn small${move.refused ? ' cant' : ''}`}
          disabled={move.refused !== undefined}
          onClick={onChoose}
        >
          {label}
          {keyed && <Key />}
        </button>
      ) : (
        <span className="ro">{label}</span>
      )}
      <p className={move.refused ? 'why' : undefined}>{move.refused ?? does}</p>
    </div>
  );
}

/**
 * A flag waiting for Martin to widen it: what it is, the one thing to know before widening, and two answers, Widen to
 * the next stage and Turn off, each opening the slider's confirmation. A visitor reads the same, read-only.
 */
function FlagCard({
  need,
  row,
  admin,
  app,
  onOpen,
  onMoved,
}: {
  need: FlagNeed;
  /** The flag's row, as Flags draws it, which the confirmation judges the move from. */
  row: FlagRow | undefined;
  admin: Admin;
  app: string | undefined;
  onMoved: () => void;
} & Placed) {
  const id = useId();
  const martin = admin.kind === 'martin';
  const [choosing, setChoosing] = useState<FlagStage | undefined>(undefined);
  const evidence: ReactNode =
    need.stage.stage === 'preview' && app ? (
      <>
        {need.evidence}{' '}
        <a className="inline" href={previewHref(app, need.flag, row?.page)} target="_blank" rel="noopener">
          Preview it<span aria-hidden="true"> ↗</span>
          <span className="sr"> (opens the app in a new tab)</span>
        </a>
      </>
    ) : (
      need.evidence
    );
  return (
    <article className="need raised ruled flag-need" {...named(id, need.kicker, onOpen)}>
      <div className="kick">
        <b>{need.kicker}</b>
        <span>
          #{need.workItem} · Verify · {STAGE_NAME[need.stage.stage]} · {need.waited}
        </span>
      </div>
      {onOpen && <h3 id={id}>{need.title}</h3>}
      <p className="ev">
        <code className="flagname">{need.flag}</code> {evidence}
      </p>
      {need.pictures && (
        <div className="pair-mini">
          <figure>
            <div className="vis">{need.pictures.off && <Shot shot={need.pictures.off} of="the flag off" />}</div>
            <figcaption>{need.pictures.off ? 'flag off' : 'flag off · no picture'}</figcaption>
          </figure>
          <figure>
            <div className="vis">
              <Shot shot={need.pictures.on} of="the flag on" />
            </div>
            <figcaption>flag on</figcaption>
          </figure>
        </div>
      )}
      <div className="answers">
        <FlagAnswer
          label={need.widen.action === 'flag.back-on' ? 'Turn back on' : `Widen to ${STAGE_NAME[need.widen.to.stage]}`}
          move={need.widen}
          does={`Shows it to more, after a confirmation that says who: ${stageWords(need.widen.to)}.`}
          martin={martin}
          onChoose={() => setChoosing(need.widen.to)}
        />
        {need.turnOff && (
          <FlagAnswer
            label="Turn off"
            move={need.turnOff}
            does={`Off for everyone within seconds, a preview too. Closes #${need.workItem}.`}
            martin={martin}
            onChoose={() => setChoosing({ stage: 'off' })}
          />
        )}
      </div>
      <Foot workItem={need.workItem} onOpen={onOpen} martin={martin} />
      {choosing && row && admin.kind === 'martin' && (
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
    </article>
  );
}

interface NeedsYouProps {
  needs: NeedsView;
  flags: FlagsView;
  admin: Admin;
  /** The app's origin, which a flag's preview opens. */
  app: string | undefined;
  onOpen: (item: string) => void;
  /** A flag was moved: the page asks again soon whether the app holds it. */
  onMoved: () => void;
}

export function NeedsYou({ needs, flags, admin, app, onOpen, onMoved }: NeedsYouProps) {
  const martin = admin.kind === 'martin';
  const { holds, canary, answered } = needs;
  // A deploy that is not his to merge yet keeps its card, but does not wait on him.
  const waiting = holds.filter((need) => need.forMartin).length + flags.needs.length + (canary ? 1 : 0);
  // Holds, the canary and flags together, oldest first.
  const none = { hold: undefined, flag: undefined, canary: undefined };
  const cards = [
    ...holds.map((need) => ({ ...none, since: need.since, key: need.hold, hold: need })),
    ...(canary ? [{ ...none, since: canary.since, key: `canary-${canary.release.id}`, canary }] : []),
    ...flags.needs.map((need) => ({ ...none, since: need.since, key: `flag-${need.flag}`, flag: need })),
  ].sort((a, b) => a.since - b.since);
  return (
    <article className="panel needs" aria-labelledby="needs-title">
      <div className="panel-head">
        <h2 id="needs-title">{martin ? 'Needs you' : 'Waiting on Martin'}</h2>
        {waiting > 0 && <span className="count-attn">{waiting} waiting</span>}
      </div>
      {cards.length ? (
        <div className="needs-list">
          {cards.map(({ key, hold, flag, canary }) =>
            canary ? (
              <CanaryCard key={key} need={canary} admin={admin} onOpen={onOpen} />
            ) : flag ? (
              <FlagCard
                key={key}
                need={flag}
                row={flags.flags.find((row) => row.name === flag.flag)}
                admin={admin}
                app={app}
                onOpen={onOpen}
                onMoved={onMoved}
              />
            ) : hold && martin ? (
              <MartinsCard key={key} need={hold} token={admin.session.token} onOpen={onOpen} />
            ) : (
              hold && <ReadOnlyCard key={key} need={hold} onOpen={onOpen} />
            ),
          )}
        </div>
      ) : (
        <p className="help">
          {martin ? 'Nothing waits on you.' : 'Nothing waits on Martin.'} A hold lands here when the line or triage
          needs a person: a spec to approve, a pull request a gate held, a fix waiting for {martin ? 'your' : 'his'}{' '}
          deploy, a flag waiting to be widened.
        </p>
      )}
      {answered.length > 0 && (
        <div className="answered">
          <span className="label">Answered today</span>
          <ul>
            {answered.map((row) => (
              <li key={`${row.workItem}-${row.at}`}>
                <span className="mono">{clock(row.at)}</span>
                <span>
                  #{row.workItem} · {row.how}.
                  {row.words === 'kept' ? (
                    <> His words stay his: the hold was about a visitor’s report.</>
                  ) : (
                    row.words && (
                      <>
                        {' '}
                        <q className="said">{row.words}</q>
                      </>
                    )
                  )}
                  {row.did && <> {row.did}</>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/**
 * What waits on Martin for one work item, at the head of its sheet: its hold's card and its flag's, the same cards as
 * in Needs you, untitled, since the sheet's title is the work item's. A visitor reads them as Waiting on Martin.
 */
export function WaitsOnMartin({
  hold,
  canary,
  flag,
  row,
  admin,
  app,
  onMoved,
}: {
  hold: Need | undefined;
  canary: CanaryNeed | undefined;
  flag: FlagNeed | undefined;
  row: FlagRow | undefined;
  admin: Admin;
  app: string | undefined;
  onMoved: () => void;
}) {
  if (!hold && !canary && !flag) return null;
  return (
    <section className="sec sheet-needs" aria-labelledby="sheet-needs-title">
      <h3 id="sheet-needs-title">{admin.kind === 'martin' ? 'Needs you' : 'Waiting on Martin'}</h3>
      <div className="needs-list">
        {hold &&
          (admin.kind === 'martin' ? (
            <MartinsCard key={hold.hold} need={hold} token={admin.session.token} />
          ) : (
            <ReadOnlyCard need={hold} />
          ))}
        {canary && <CanaryCard key={canary.release.id} need={canary} admin={admin} />}
        {flag && <FlagCard need={flag} row={row} admin={admin} app={app} onMoved={onMoved} />}
      </div>
    </section>
  );
}
