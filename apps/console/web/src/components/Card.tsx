/**
 * A card in the reel: the item's category, kind and outcome; its picture; a title and two lines; one line of
 * facts; and eight segments, one per stage.
 */
import { STAGES } from '@software-factory/events';
import { memo, type Ref } from 'react';
import { duration, money, shortVersion, shortWhen } from '../format.ts';
import type { Card as CardData, Outcome, Versions } from '../projection/index.ts';
import { segmentsLabel } from '../projection/index.ts';
import { backWords } from '../projection/release.ts';
import { CATEGORY_NAME, Glyph } from './Glyph.tsx';
import { Picture } from './Pictures.tsx';

const KIND_NAME: Record<CardData['kind'], string> = {
  'defect-fix': 'Defect fix',
  'injected-defect': 'Injected defect',
  improvement: 'Improvement',
  'dependency-update': 'Dependency update',
  'red-team': 'Red-team attack',
  'visitor-report': 'Visitor report',
  'planner-finding': 'Planner’s finding',
};

/** The kind of work, saying when a visitor started it: never which visitor. */
export function kindName({ kind, byVisitor }: Pick<CardData, 'kind' | 'byVisitor'>): string {
  if (byVisitor && kind === 'injected-defect') return 'Injected by a visitor';
  if (byVisitor && kind === 'red-team') return 'Red-team attack by a visitor';
  return KIND_NAME[kind];
}

/**
 * An outcome's word and tone, and whether it waits on a human. Work nobody needs to act on is in the quiet tone:
 * closed work, a quarantined report (a guardrail that worked), a ticket waiting for the planner, and a fix Martin
 * merged, waiting for a release, or for a deploy pull request that is not his to merge yet: not green, because nothing
 * has verified it.
 */
export const OUTCOME: Record<Outcome, [word: string, tone: 'ok' | 'attn' | 'faint' | 'signal', waits: boolean]> = {
  verified: ['Verified', 'ok', false],
  'rolled-back': ['Rolled back', 'attn', false],
  held: ['Held for a human', 'attn', true],
  closed: ['Closed · no change', 'faint', false],
  quarantined: ['Quarantined', 'faint', false],
  'no-ticket': ['Closed · no ticket', 'faint', false],
  'turned-off': ['Turned off', 'faint', false],
  'needs-you': ['Needs you', 'attn', true],
  waiting: ['Waiting for the planner', 'faint', false],
  'waits-on-work': ['Waiting on overlapping work', 'faint', false],
  merged: ['Merged · waiting for release', 'faint', false],
  deploying: ['Merged · waiting for its deploy', 'faint', false],
  'in-progress': ['In progress', 'signal', false],
};

export function OutcomeWord({ outcome }: { outcome: Outcome }) {
  const [word, tone, waits] = OUTCOME[outcome];
  // Waiting is a hollow dot: work queued, with nobody at it yet.
  const dot =
    outcome === 'in-progress'
      ? 'blink'
      : outcome === 'waiting' || outcome === 'waits-on-work' || outcome === 'merged' || outcome === 'deploying'
        ? 'hollow'
        : waits
          ? 'ring alarm'
          : tone === 'attn'
            ? 'ring'
            : '';
  return (
    <span className={`out tone-${tone}`}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      {word}
    </span>
  );
}

/**
 * The version pill: what shipped, what it replaced when that was rolled back or stopped, what is still on the canary.
 * Before a release, the version a sense saw the problem on, or the page a visitor's report came from.
 */
function VersionPill({
  versions,
  seenOn,
  from: page,
  back,
}: {
  versions: Versions;
  seenOn?: string | undefined;
  from?: string | undefined;
  /** A reopened ticket's version, the one its sense saw it on again, until a release of its own. */
  back?: string | undefined;
}) {
  const { rolledBack, stopped, onCanary } = versions;
  const [from, to] = [versions.from, versions.to].map((v) => v && shortVersion(v));
  if (!to && !from && back) return <span className="ver">back on {shortVersion(back)}</span>;
  if (!to && !from && page) return <span className="ver">from {page}</span>;
  if (!to && !from && seenOn) return <span className="ver">seen on {shortVersion(seenOn)}</span>;
  if (!to && !from) return <span className="ver muted">no release</span>;
  if (rolledBack || stopped) {
    return (
      <span className="ver">
        <s>{to}</s>
        {/* The line-through says it to the eye; this says it to a screen reader. */}
        <span className="sr"> ({backWords(stopped)})</span> → {from}
      </span>
    );
  }
  if (onCanary) {
    return (
      <span className="ver">
        {from} → <span className="muted">{to}</span>
      </span>
    );
  }
  return <span className="ver">{to ?? from}</span>;
}

/** Outcomes still under way, whose duration is so far. */
export const ONGOING = new Set<Outcome>([
  'in-progress',
  'needs-you',
  'held',
  'waiting',
  'waits-on-work',
  'merged',
  'deploying',
]);

/** What the work spent on models: "no model" when nothing was called, and "$0 · local" when the local model did it all. */
export const spendWords = ({ calls, local, spend }: Pick<CardData, 'calls' | 'local' | 'spend'>) =>
  !calls ? 'no model' : local ? '$0 · local' : money(spend);

const SEGMENT_CLASS = {
  passed: 'o',
  skipped: 's',
  now: 'n',
  stopped: 'x',
  waiting: 'w',
  closed: 'k',
  queued: 'q',
  none: '',
} as const;

interface CardProps {
  card: CardData;
  index: number;
  count: number;
  ref: Ref<HTMLElement>;
}

export const Card = memo(function Card({ card, index, count, ref }: CardProps) {
  const [word] = OUTCOME[card.outcome];
  return (
    <article
      ref={ref}
      className="card"
      data-index={index}
      aria-roledescription="slide"
      aria-label={`${index + 1} of ${count}: ${card.title}. ${card.reopened ? 'Reopened. ' : ''}${word}`}
    >
      <div className={`card-top ${card.reopened ? 'again' : ''}`}>
        <span className="cat">
          <Glyph name={card.category} />
          {CATEGORY_NAME[card.category]}
          <span className="kind">· {kindName(card)}</span>
        </span>
        {card.reopened ? (
          <span className="again-out">
            <span className="pill-sample again">Reopened</span>
            <OutcomeWord outcome={card.outcome} />
          </span>
        ) : (
          <OutcomeWord outcome={card.outcome} />
        )}
      </div>
      <Picture picture={card.picture} interactive={false} />
      <div>
        <h3>{card.title}</h3>
        <p className="desc">{card.description}</p>
      </div>
      <div className="meta">
        {card.sample && <span className="pill-sample">Sample</span>}
        <b>#{card.number}</b>
        {card.flag && (
          <span className="flagm" title={`Its flag, ${card.flag.name}`}>
            <Glyph name="flag" />
            <span className="sr">its flag, {card.flag.name}, at </span>
            {card.flag.stage}
          </span>
        )}
        <VersionPill versions={card.versions} seenOn={card.seenOn} from={card.from} back={card.reopened?.version} />
        {card.pullRequest && <span className="opt">PR #{card.pullRequest}</span>}
        <span>{shortWhen(card.startedAt)}</span>
        <span>
          {duration(card.durationMs)}
          {ONGOING.has(card.outcome) ? ' so far' : ''}
        </span>
        {/* No model at all is a choice, not a missing figure: a sense knows what it saw. */}
        <span>{spendWords(card)}</span>
      </div>
      <div className="card-foot">
        <span className="prog" role="img" aria-label={segmentsLabel(card.segments)}>
          {card.segments.map((segment, i) => (
            <i key={STAGES[i]} className={SEGMENT_CLASS[segment]} />
          ))}
        </span>
        <span className="open-hint" aria-hidden="true">
          OPEN ↑
        </span>
      </div>
    </article>
  );
});
