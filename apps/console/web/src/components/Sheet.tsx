/**
 * The sheet: one work item in full, raised from the bottom of the screen over most of it. It holds focus while it
 * is open and gives it back when it closes; previous and next step between work items, and the reel follows.
 *
 * What waits on Martin for the work item heads it, as Needs you's cards, and an improvement's flag has its slider:
 * Martin answers and moves the flag here as there, and a visitor reads both, read-only.
 */

import { MODEL_AGENTS, type Sense } from '@software-factory/events';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Admin } from '../admin.ts';
import {
  AGENT_NAME,
  APP_REPO,
  capital,
  clock,
  duration,
  inWords,
  isCommit,
  listed,
  modelTitle,
  money,
  plural,
  shortVersion,
  shortWhen,
  sinceStart,
  tokens,
  when,
} from '../format.ts';
import type {
  AgentRow,
  Attempt,
  Chapter,
  GateRow,
  Picture as PictureData,
  RoundsNow,
  Sheet as SheetData,
  Sighting,
  ThreadReview,
} from '../projection/index.ts';
import { deployWords, SENSE, scrubbed, TARGET } from '../projection/index.ts';
import { backWords } from '../projection/release.ts';
import { REPORT_KEPT_DAYS } from '../projection/report.ts';
import { kindName, ONGOING, OutcomeWord, spendWords } from './Card.tsx';
import { FlagSection } from './FlagSheet.tsx';
import { CATEGORY_NAME, Glyph } from './Glyph.tsx';
import { LogoMark, ToolMark, type ToolName } from './Logos.tsx';
import { WaitsOnMartin } from './NeedsYou.tsx';
import { keyed, Picture, Shot, useMeasured } from './Pictures.tsx';
import { ShippedSection } from './Shipped.tsx';

const SOURCE: Record<PictureData['type'], string> = {
  wipe: 'Playwright screenshots, taken when the signal fired and after rollout. The marks are drawn from the elements the probe checked.',
  screenshot: 'A Playwright screenshot, taken when the signal fired.',
  metric: 'Prometheus, kept in the event at verify, so the graph outlives the metrics’ retention.',
  logs: 'Loki and Tempo, excerpted into the events at the signal and at verify.',
  package: 'The pull request’s lockfile change, and every page compared with the version before.',
  scan: 'The image scan of both images, run as a required check in the pipeline.',
  rollback: 'Argo Rollouts’ analysis run, with the series it compared.',
  refusal: 'The mechanism’s own output, stored with the event when it refused.',
  judgement: 'The Jev request in the event: question set, model version and every answer with its probability.',
  quarantine:
    'The Jev request in the event, and the threshold in the factory’s policy that quarantines a report. The report’s text is not in it.',
  suggestion: 'The Jev request in the event, and the factory’s own screenshot of the page the report named.',
  spec: 'The planner’s spec, as it waits for Martin.',
  merge: 'The pull request’s last push, its checks and its review, as the events record them.',
  deploy: 'The merge, as the events record it.',
  scope: 'The scope fence’s own output, stored with the event when it refused.',
  'tests-pass': 'The tests-first check’s own output, from running the change’s tests on the base.',
  spend: 'The gateway’s log of every call, summed for each agent.',
  blocking: 'The reviewer’s findings, kept in each review’s event.',
  pages: 'The crawler’s screenshots of the pages it crawled, each marked where its check looked.',
  http: 'The sense’s own request, and what came back, kept in the event.',
  console: 'The browser’s console, as Playwright recorded it, beside its screenshot of the page.',
  accessibility: 'axe, run in the browser by the sense, with the boxes of the elements it named.',
  none: '',
};

/** The tools that made each kind of evidence, whose marks stand before its source line. */
const TOOLS: Partial<Record<PictureData['type'], ToolName[]>> = {
  wipe: ['playwright'],
  screenshot: ['playwright'],
  console: ['playwright'],
  metric: ['prometheus'],
  logs: ['loki', 'tempo'],
  rollback: ['argo'],
};

/** Admission control's refusal: Kyverno's own words, on an image Sigstore's signature did not vouch for. */
const ADMISSION_SOURCE =
  'Kyverno’s own refusal, stored with the event: it admits only an image whose Sigstore signature says the pipeline built it on main, or one of the few it names by digest.';

/** What each sense captures, for an evidence block's caption (after the sense's name) and its source line. */
const CAPTURED: Record<Sense, [what: string, source: string, tool?: ToolName]> = {
  probe: ['', 'Playwright', 'playwright'],
  crawler: ['', 'the crawler’s request'],
  metrics: [' · alert', 'the series behind Prometheus’s alert', 'prometheus'],
  logs: ['', 'Loki', 'loki'],
  canary: [' · analysis', 'Argo Rollouts’ analysis of the release', 'argo'],
  report: ['', 'the widget'],
};

const KIND_OF: Partial<Record<PictureData['type'], string>> = {
  screenshot: 'screenshot',
  pages: 'every page',
  http: 'HTTP',
  console: 'console',
  accessibility: 'axe',
  logs: 'new pattern',
  metric: '',
};

/** The provider that served a row's calls, as the events name it. */
const PROVIDER: Record<AgentRow['provider'], string> = {
  typesafe: 'TypeSafe',
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  local: 'local',
};

/** "Jev 1.13.0 · TypeSafe", "Claude Opus 5.5 · Anthropic". */
const modelName = (row: AgentRow) =>
  `${row.provider === 'typesafe' ? `Jev ${row.model.replace(/^jev-/, '')}` : modelTitle(row.model)} · ${PROVIDER[row.provider]}`;

const SIDE_NAME: Record<string, string> = {
  broken: 'Signal',
  canary: 'On the canary',
  fixed: 'Full rollout',
  after: 'Full rollout',
  before: 'Before',
};

interface SheetProps {
  sheet: SheetData;
  index: number;
  count: number;
  motion: boolean;
  onStep: (to: number) => void;
  onClose: () => void;
  /** The app's origin, which a flag's preview opens. */
  app?: string | undefined;
  /** Who is reading: Martin answers and moves the flag here, a visitor reads. */
  admin: Admin;
  /** A flag was moved: the page asks again soon whether the app holds it. */
  onMoved: () => void;
}

export function Sheet({ sheet, index, count, motion, onStep, onClose, app, admin, onMoved }: SheetProps) {
  const dialog = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [risen, setRisen] = useState(false);
  const { card } = sheet;

  // Rise on the next frame, so the move from below is drawn; give focus back on the way out.
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    document.body.classList.add('locked');
    const frame = requestAnimationFrame(() => setRisen(true));
    return () => {
      cancelAnimationFrame(frame);
      document.body.classList.remove('locked');
      const back = opener.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  // A new work item starts at the top, with its title focused.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each work item the sheet shows
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    title.current?.focus({ preventScroll: true });
  }, [card.number]);

  // An answered card leaves the sheet with the button that had focus, and a flag's card is drawn again at its next
  // stage: the title takes focus, so the sheet keeps it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as what waits on Martin changes
  useEffect(() => {
    if (document.activeElement === document.body) title.current?.focus({ preventScroll: true });
  }, [sheet.needs.hold?.hold, sheet.needs.canary?.release.id, sheet.needs.flag?.flag, sheet.needs.flag?.stage.stage]);

  const close = () => {
    if (!motion) return onClose();
    setRisen(false);
    setTimeout(onClose, 420);
  };

  // Escape closes; Tab stays inside while the sheet is open.
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // A dialog opened from the sheet (an answer's, a flag's) keeps its own keys: Escape closes it, not the sheet.
    if (event.target instanceof Element && event.target.closest('dialog')) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'),
    ];
    const [first, last] = [focusable[0], focusable.at(-1)];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const ongoing = ONGOING.has(card.outcome);
  const released = Boolean(card.versions.to || card.versions.from);
  const [from, to] = [card.versions.from, card.versions.to].map((v) => v && shortVersion(v));
  const versions =
    card.versions.rolledBack || card.versions.stopped
      ? `${to} · ${backWords(card.versions.stopped)} · stayed on ${from}`
      : card.versions.onCanary
        ? `broken in ${from} · the fix is ${to}`
        : to
          ? `${from ?? '—'} → ${to}`
          : 'No release';
  const bySense = sheet.senseEvidence.length > 1;
  const total = sheet.agents.reduce((sum, a) => sum + a.cost, 0);
  const evidence = sheet.evidence;

  return (
    <>
      <div className={`scrim ${risen ? 'open' : ''}`} onClick={close} aria-hidden="true" />
      <section
        ref={dialog}
        className={`sheet ${risen ? 'open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onKeyDown={onKeyDown}
      >
        <div className="grab" aria-hidden="true" />
        <div className="wrap sheet-wrap">
          <header className="sheet-head">
            <div className="sheet-title">
              <div className="kicker">
                <span className="cat">
                  <Glyph name={card.category} />
                  {CATEGORY_NAME[card.category]}
                </span>
                <span className="kind">{kindName(card)}</span>
                {card.reopened && <span className="pill pill-sample again">Reopened</span>}
                <OutcomeWord outcome={card.outcome} />
                {card.sample && <span className="pill pill-sample">Sample</span>}
              </div>
              <h2 id="sheet-title" tabIndex={-1} ref={title}>
                {card.title}
              </h2>
            </div>
            <div className="sheet-nav">
              <button
                type="button"
                className="icon-btn"
                aria-label="Previous work item"
                disabled={index === 0}
                onClick={() => onStep(index - 1)}
              >
                <Glyph name="left" />
              </button>
              <span className="count">#{card.number}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Next work item"
                disabled={index >= count - 1}
                onClick={() => onStep(index + 1)}
              >
                <Glyph name="right" />
              </button>
              <button type="button" className="icon-btn close" aria-label="Close" onClick={close}>
                <Glyph name="cross" />
              </button>
            </div>
          </header>
        </div>
        <div className="sheet-scroll" ref={scroller}>
          <div className="wrap sheet-body">
            <div className="sheet-main">
              <WaitsOnMartin
                hold={sheet.needs.hold}
                canary={sheet.needs.canary}
                flag={sheet.needs.flag}
                row={sheet.flag?.row}
                admin={admin}
                app={app}
                onMoved={onMoved}
              />
              <div>
                <p className="lead">
                  {sheet.story}
                  {sheet.closing && ` ${sheet.closing}`}
                </p>
                {sheet.storyBy === 'describer' && (
                  <p className="source byline">
                    The describer, from the ticket, the spec, the final diff and the review
                    {sheet.closing && '; the last sentence is the console’s, from what happened since'}. The pull
                    request’s own description is on GitHub.
                  </p>
                )}
              </div>
              {card.sample && (
                <p className="notice sample-note">
                  <span className="label">Sample</span>
                  Written by hand to show what the console will show. Nothing here happened; the screenshots are of the
                  real app, with this sample’s change made in a copy that went nowhere.
                </p>
              )}
              {sheet.report && <Report report={sheet.report} />}
              {sheet.request && <Request request={sheet.request} />}
              <Section
                title="How it went"
                help="Step through the stages. The console shows only what had happened by then: replay and the live view are the same code."
              >
                <Replay chapters={sheet.chapters} motion={motion} key={card.number} />
              </Section>
              {bySense && (
                <Section
                  title="Evidence"
                  help="Captured when it happened, because the sources expire. One block for each sense, the first time it saw the problem."
                >
                  <div className="captures by-sense">
                    {sheet.senseEvidence.map((block) => (
                      <figure key={block.sense}>
                        <Picture picture={block.picture} interactive={false} />
                        <figcaption>
                          <span>
                            {SENSE[block.sense].name}
                            {CAPTURED[block.sense][0]}
                            {KIND_OF[block.picture.type] ? ` · ${KIND_OF[block.picture.type]}` : ''}
                          </span>
                          <span className="mono">{clock(block.at)}</span>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                  <Source tools={sheet.senseEvidence.flatMap((block) => CAPTURED[block.sense][2] ?? [])}>
                    Each sense’s own capture: {listed(sheet.senseEvidence.map((block) => CAPTURED[block.sense][1]))}.
                  </Source>
                </Section>
              )}
              {!bySense && evidence.type !== 'spec' && evidence.type !== 'none' && (
                <Section title="Evidence" help="Captured when it happened, because the sources expire.">
                  <div className="evidence-big">
                    <Picture picture={evidence} interactive />
                  </div>
                  {evidence.type === 'refusal' && evidence.admission ? (
                    <Source tools={['kyverno', 'sigstore']}>{ADMISSION_SOURCE}</Source>
                  ) : (
                    <Source tools={TOOLS[evidence.type]}>{SOURCE[evidence.type]}</Source>
                  )}
                  {sheet.captures.length > 1 && (
                    <div className="captures">
                      {sheet.captures.map((capture) => (
                        <figure key={`${capture.shot.hash}-${capture.shot.route}-${capture.at}`}>
                          <div className="vis">
                            <Shot shot={capture.shot} numbered={evidence.type === 'pages'} />
                          </div>
                          <figcaption>
                            {/* Every page's screenshot is named by its page; the others by when in the story. */}
                            <span>{evidence.type === 'pages' ? capture.shot.route : SIDE_NAME[capture.side]}</span>
                            <span className="mono">{sinceStart(capture.at - card.startedAt)}</span>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  )}
                </Section>
              )}
              {sheet.flag ? (
                <FlagSection flag={sheet.flag} app={app} admin={admin} onMoved={onMoved} />
              ) : (
                <ShippedSection sheet={sheet} />
              )}
              {sheet.spec ? (
                <SpecSection sheet={sheet} />
              ) : (
                sheet.files && (
                  <Section title="The change" help="What the pull request touched.">
                    <div className="files">
                      {keyed(sheet.files, (file) => file.path).map(({ key, value: file }) => (
                        <div key={key}>
                          <span>{file.path}</span>
                          <span className="plus">+{file.added}</span>
                          <span className="minus">−{file.removed}</span>
                        </div>
                      ))}
                    </div>
                  </Section>
                )
              )}
              {sheet.rounds.length > 0 && (
                <Section
                  title="Rounds"
                  help={`Each attempt the coder pushed, what the gates and the reviewer made of it, and why it went back. ${capital(inWords(sheet.facts.reviews?.of ?? 2, 'review'))} at most in a pass: after the last, anything still blocking waits for Martin.`}
                >
                  <Rounds rounds={sheet.rounds} now={sheet.roundsNow} after={sheet.after} />
                </Section>
              )}
              {sheet.review.length > 0 && (
                <Section
                  title="Review"
                  help="The reviewer reads the diff against the rules at the base commit, so a pull request cannot loosen the rules it is judged by. Its review is a signal, never a gate."
                >
                  <ReviewThread reviews={sheet.review} start={card.startedAt} open={card.picture.type === 'blocking'} />
                  <Source>
                    {card.pullRequest ? `The review the App posted on PR #${card.pullRequest}, kept in the event.` : ''}{' '}
                    Each rule as the app’s docs/REVIEWERS.md words it.
                  </Source>
                </Section>
              )}
            </div>
            <aside className="sheet-side">
              <dl className="facts-dl raised">
                <Fact name="Work item">#{card.number}</Fact>
                {sheet.facts.ticket && (
                  <>
                    <Fact name="Ticket">
                      {sheet.facts.ticket.category} · {sheet.facts.ticket.severity}
                    </Fact>
                    <Fact name="Fingerprint">{sheet.facts.ticket.fingerprint}</Fact>
                  </>
                )}
                {!sheet.seenBy && <Fact name="Found by">{sheet.facts.foundBy}</Fact>}
                {sheet.facts.flag && <Fact name="Flag">{sheet.facts.flag}</Fact>}
                {!released && card.reopened ? (
                  <Fact name="Version">back on {shortVersion(card.reopened.version)}</Fact>
                ) : !released && card.seenOn ? (
                  <Fact name="Seen on">
                    <Version version={card.seenOn} sample={card.sample} />
                  </Fact>
                ) : (
                  <Fact name="Version">{versions}</Fact>
                )}
                {card.reopened && (
                  <Fact name="Reopened">
                    {shortWhen(card.reopened.at)} · {card.reopened.sense}, {card.reopened.check} on{' '}
                    {card.reopened.route === '*' ? 'every page' : card.reopened.route} from{' '}
                    {shortVersion(card.reopened.version)}
                  </Fact>
                )}
                {card.pullRequest && (
                  <Fact name="Pull request">
                    {/* A sample's pull request never existed, so it links nowhere. */}
                    {card.sample ? (
                      `#${card.pullRequest}`
                    ) : (
                      <a href={`${APP_REPO}/pull/${card.pullRequest}`}>#{card.pullRequest} on GitHub</a>
                    )}
                  </Fact>
                )}
                {sheet.deploy?.deploy && (
                  <Fact name="Deploy">
                    {/* As the pull request's: a sample's deploy pull request never existed either. */}
                    {card.sample ? (
                      `#${sheet.deploy.deploy.pullRequest}`
                    ) : (
                      <a href={`${APP_REPO}/pull/${sheet.deploy.deploy.pullRequest}`}>
                        #{sheet.deploy.deploy.pullRequest} on GitHub
                      </a>
                    )}{' '}
                    · {deployWords(sheet.deploy.deploy).fact}
                  </Fact>
                )}
                {sheet.facts.reviews && (
                  <Fact name="Reviews">
                    {sheet.facts.reviews.done} of {sheet.facts.reviews.of}
                    {sheet.facts.reviews.pass !== undefined && ` · pass ${sheet.facts.reviews.pass}`}
                  </Fact>
                )}
                <Fact name="Started">{when(card.startedAt)}</Fact>
                <Fact name={ongoing ? 'So far' : 'Start to finish'}>{duration(card.durationMs)}</Fact>
                <Fact name="Model spend">{card.calls ? spendWords(card) : 'none'}</Fact>
                <Fact name="Code written by humans">{plural(sheet.facts.humanLines, 'line')}</Fact>
              </dl>
              {sheet.seenBy && <SeenBy rows={sheet.seenBy} />}
              <div className="side-card raised">
                <h3>Agents and models</h3>
                {sheet.agents.length ? (
                  <table className="models">
                    <thead className="label small">
                      <tr>
                        <th>Agent and model</th>
                        <th className="num">Calls</th>
                        <th className="num">Tokens</th>
                        <th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.agents.map((a) => (
                        <tr key={`${a.agent}/${a.model}`}>
                          <td>
                            <div className="who">
                              {/* Where a local model ran is what matters, not whose model it is: a laptop, no logo. */}
                              {a.provider === 'local' ? (
                                <Glyph name="local" className="glyph logo" />
                              ) : (
                                <LogoMark name={a.provider === 'typesafe' ? 'jev' : 'anthropic'} />
                              )}
                              <span>
                                {AGENT_NAME[a.agent] ?? a.agent}
                                <small>{modelName(a)}</small>
                                {a.details.map((line) => (
                                  <small key={line} className="mono">
                                    {line}
                                  </small>
                                ))}
                              </span>
                            </div>
                          </td>
                          <td className="num">{a.calls}</td>
                          <td className="num">
                            {a.tokensIn ? (
                              <>
                                {tokens(a.tokensIn)} in<small>{tokens(a.tokensOut)} out</small>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className={`num ${a.provider === 'local' ? 'free' : ''}`}>
                            {a.provider === 'local' ? '$0' : money(a.cost)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>{card.local ? 'Total · all local' : `Total${ongoing ? ' so far' : ''}`}</td>
                        <td className="num">{sheet.agents.reduce((sum, a) => sum + a.calls, 0)}</td>
                        <td />
                        <td className="num">{card.local ? '$0' : money(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                ) : (
                  <p className="help">
                    <b>No model was called.</b> {sheet.noModel}
                  </p>
                )}
                {sheet.agents.some((a) => (MODEL_AGENTS as readonly string[]).includes(a.agent)) && (
                  <p className="help tooled ran">
                    <ToolMark name="kubernetes" />
                    <span>
                      Each step of the line’s agents ran in a Kubernetes pod of its own in the <code>runners</code>{' '}
                      namespace, able to reach the gateway and the line, and nothing else.
                    </span>
                  </p>
                )}
                <Source>
                  The gateway’s log of every call. On the replay site the same calls come from cassettes.
                  {sheet.agents.some((a) => a.provider === 'local') &&
                    ' Local calls are counted and capped like any other, and priced at nothing.'}
                </Source>
              </div>
              <div className="side-card raised">
                <h3>
                  Gates
                  {sheet.gatesAttempt && <span className="attempt"> · attempt {sheet.gatesAttempt}</span>}
                </h3>
                {sheet.gates.length ? (
                  <div className="gates">
                    {sheet.gates.map((g) => (
                      <Gate key={g.check} gate={g} />
                    ))}
                    {sheet.signals.length > 0 && (
                      <>
                        <span className="label sub">Signals, not required</span>
                        {sheet.signals.map((g) => (
                          <Gate key={g.check} gate={g} />
                        ))}
                      </>
                    )}
                  </div>
                ) : (
                  <p className="help">
                    {ongoing ? 'No pull request yet, so no gates have run.' : 'No pull request, so no gates ran.'}
                  </p>
                )}
                {sheet.earlier.map((line) => (
                  <p key={line} className="help gates-note">
                    {line}
                  </p>
                ))}
                {card.outcome === 'rolled-back' && (
                  <p className="help gates-note">Every gate passed. The canary caught what tests could not.</p>
                )}
              </div>
            </aside>
          </div>
        </div>
      </section>
    </>
  );
}

const GATE_GLYPH = { success: 'check', skipped: 'check', failure: 'cross', neutral: 'dash' } as const;

/** One check, its result and time, and its own one line where it gave one. */
function Gate({ gate }: { gate: GateRow }) {
  return (
    <div
      className={`gate ${gate.conclusion === 'failure' ? 'fail' : gate.conclusion === 'neutral' ? 'neutral' : 'pass'}`}
    >
      <Glyph name={GATE_GLYPH[gate.conclusion]} />
      <span>
        {gate.check}
        {gate.summary && <small>{gate.summary}</small>}
      </span>
      <span className="time">{gate.durationMs !== undefined ? duration(gate.durationMs) : ''}</span>
    </div>
  );
}

const RISK_WORDS: Record<string, string> = {
  'test-loosening': 'it loosens a test',
  'dependency-change': 'it changes a dependency',
  'security-headers': 'it touches security headers',
  'out-of-scope': 'it reaches outside the ticket',
};

/**
 * Martin's request for an improvement, in his words as everyone may read them, ruled on the left as his rows in the
 * audit log are. React inserts them as text.
 */
function Request({ request }: { request: NonNullable<SheetData['request']> }) {
  return (
    <figure className="martins-request raised ruled">
      <span className="label">The request · in Martin’s words · {when(request.at)}</span>
      <blockquote>{request.words}</blockquote>
      <figcaption className="help">
        Asked with the “+” on Plan{request.steppedUp && ', with his passkey'}. An improvement starts only from Martin: a
        visitor’s suggestion never starts work by itself.
      </figcaption>
    </figure>
  );
}

/**
 * The spec: its outcome, its criteria, and its scope, with what the pull request changes in it, or what the last
 * patch the fence refused would have. An improvement's says, in a box, what it changes, the flag it goes behind and
 * the pages it changes, and under each criterion the side of the flag it is tested with.
 */
function SpecSection({ sheet }: { sheet: SheetData }) {
  const { spec, scope, card } = sheet;
  if (!spec) return null;
  const of = scope?.of;
  const built = of !== undefined;
  const refused = of !== undefined && 'refused' in of;
  const improvement = card.kind === 'improvement' && spec.flag !== undefined;
  return (
    <Section
      title="The spec"
      help={
        built
          ? 'What the planner asked for, and the files it allowed the coder to change. A patch outside them is refused.'
          : card.outcome === 'needs-you'
            ? improvement
              ? 'What the planner proposes. Nothing is built until Martin approves it, with his passkey.'
              : 'Acceptance criteria the planner proposes. Nothing is built until Martin approves.'
            : 'What the planner asked for, and the files it allows the coder to change. A patch outside them is refused.'
      }
    >
      {improvement ? (
        <dl className="spec-dl raised">
          <dt>What it changes</dt>
          <dd>{spec.outcome}</dd>
          <dt>Its flag</dt>
          <dd>
            <code className="flagname">{spec.flag}</code>, off until Martin widens it
          </dd>
          {spec.pages && (
            <>
              <dt>{spec.pages.length === 1 ? 'The page it changes' : 'The pages it changes'}</dt>
              <dd className="mono">{spec.pages.join(', ')}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="spec-outcome">{spec.outcome}</p>
      )}
      <ul className={`criteria ${card.outcome === 'verified' ? 'met' : ''}`}>
        {spec.criteria.map((c) => (
          <li className="raised" key={c.given + c.when}>
            <Glyph name={card.outcome === 'verified' ? 'check' : 'dash'} />
            <span>
              <em>GIVEN</em> {c.given} <em>WHEN</em> {c.when} <em>THEN</em> {c.expect}
              {c.from && (
                <>
                  {' '}
                  <em>FROM</em> {c.from}
                </>
              )}
              {c.withFlag && <small className="side">tested with the flag {c.withFlag}</small>}
            </span>
          </li>
        ))}
      </ul>
      {scope && (
        <table className="scope raised">
          <thead className="label small">
            <tr>
              <th>
                {of === undefined
                  ? 'May change'
                  : 'refused' in of
                    ? `May change · patch ${of.refused}, refused`
                    : `May change · PR #${of.pullRequest}`}
              </th>
              <th className="num">{built ? 'Added' : ''}</th>
              <th className="num">{built ? 'Removed' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {keyed(scope.rows, (row) => row.path).map(({ key, value: row }) => (
              <tr key={key} className={row.outside ? 'refused' : ''}>
                <td className={`path ${row.added === undefined ? 'muted' : ''}`}>
                  {row.path}
                  {/* The line-through and the colour say it to the eye; this says it to a screen reader. */}
                  {row.outside && (
                    <span className="sr">{refused ? ' (outside the scope, refused)' : ' (outside the scope)'}</span>
                  )}
                </td>
                {row.added === undefined ? (
                  <td className="muted" colSpan={2}>
                    {built ? 'untouched' : ''}
                  </td>
                ) : (
                  <>
                    <td className="num plus">+{row.added}</td>
                    <td className="num minus">−{row.removed}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="risks">
        <span className="label">Risks</span>
        <span>{spec.risks.length ? spec.risks.map((r) => RISK_WORDS[r] ?? r).join('; ') : 'none'}</span>
        <span className="label">Rollout</span>
        <span>{spec.rollout}</span>
      </p>
    </Section>
  );
}

const VERDICT = { approved: 'Approved', 'changes-requested': 'Changes asked', escalated: 'Escalated' } as const;

/**
 * Rounds: one row per attempt, one column per stage it passed through, and between two rows the same dashed return
 * arc the line draws, from the stage that sent it back to Build, so the shape learned on the line means the same here.
 * A return's next round is drawn before the coder pushes it, hollow, so the arc always lands on a Build; and a step in
 * hand moves, as the line's stations do.
 */
function Rounds({ rounds, now, after }: { rounds: Attempt[]; now: RoundsNow; after: SheetData['after'] }) {
  return (
    <div className="rounds">
      <span />
      <span className="label small colh">Build</span>
      <span className="label small colh">Gates</span>
      <span className="label small colh">Review</span>
      {rounds.map((a, i) => (
        <RoundRow
          key={`${a.pass}-${a.attempt}`}
          attempt={a}
          followed={
            i < rounds.length - 1
              ? rounds[i + 1]?.pass === a.pass && rounds[i + 1]?.attempt === a.attempt + 1
              : Boolean(now.next)
          }
          reviewing={i === rounds.length - 1 && now.reviewing}
        />
      ))}
      {now.next && <NextRound attempt={now.next.attempt} building={now.next.building} />}
      {after && (
        <div className="after raised ruled">
          <OutcomeWord outcome={after.outcome} />
          <span>{after.text}</span>
        </div>
      )}
    </div>
  );
}

/**
 * A step in hand: the word, and a short bar sliding along the cell's foot. The bar stands still when motion is off,
 * and the word says it alone; React draws it once, and the browser moves it.
 */
function Running() {
  return (
    <>
      <span className="cell-state">Running</span>
      <span className="busy" aria-hidden="true" />
    </>
  );
}

/** The round a return sent the work into, before the coder has pushed it: hollow, each step waiting or in hand. */
function NextRound({ attempt, building }: { attempt: number; building: boolean }) {
  return (
    <>
      <div className="label small rn">
        Round<b>{attempt}</b>
      </div>
      <div className={`cell raised next${building ? ' running' : ''}`}>
        {building ? <Running /> : <span className="cell-state muted">Waiting</span>}
      </div>
      <div className="cell raised next">
        <span className="cell-state muted">Waiting</span>
      </div>
      <div className="cell raised next">
        <span className="cell-state muted">Waiting</span>
      </div>
    </>
  );
}

/** Where each stage's column is centred in the return's row, out of 300. */
const COLUMN: Record<string, number> = { build: 50, gates: 150, review: 250 };

/**
 * One attempt, in the coder's round of the same number: the line's round, as the return's pill names it. Its return's
 * arc is drawn only to the round it sent the work into, in the same pass.
 */
function RoundRow({ attempt: a, followed, reviewing }: { attempt: Attempt; followed: boolean; reviewing: boolean }) {
  const gates = a.gates;
  const review = a.review;
  const from = a.returned ? (COLUMN[a.returned.from] ?? 250) : 0;
  const gatesRunning = gates?.state === 'running';
  return (
    <>
      <div className="label small rn">
        Round<b>{a.attempt}</b>
      </div>
      <div className="cell raised">
        <span className="cell-state">Attempt {a.attempt}</span>
        <small>
          {a.how}
          {a.commit ? ` · ${a.commit.slice(0, 7)}` : ''}
        </small>
        <small>
          <span className="plus">+{a.added}</span> <span className="minus">−{a.removed}</span> ·{' '}
          {plural(a.files, 'file')}
        </small>
      </div>
      <div className={`cell raised${gatesRunning ? ' running' : ''}`}>
        {gates ? (
          <>
            {gatesRunning ? (
              <Running />
            ) : (
              <span className={`cell-state ${gates.state === 'passed' ? 'ok' : ''}`}>
                <Glyph name={gates.state === 'passed' ? 'check' : 'cross'} />
                {`${gates.passed} of ${gates.total}`}
              </span>
            )}
            {gates.state === 'failed' && <small>{gates.failed.join(', ')} failed</small>}
            {gates.testsFirst && (
              <small>
                {gates.testsFirst.failedOnBase
                  ? `tests fail on base${gates.testsFirst.figure ? `: ${gates.testsFirst.figure}` : ''}`
                  : 'tests pass on base'}
              </small>
            )}
          </>
        ) : (
          <span className="cell-state muted">Waiting</span>
        )}
      </div>
      <div className={`cell raised${reviewing ? ' running' : ''}`}>
        {review ? (
          <>
            <span className={`cell-state ${review.verdict === 'approved' ? 'ok' : ''}`}>
              {review.verdict === 'approved' && <Glyph name="check" />}
              {VERDICT[review.verdict]}
            </span>
            <small>
              {[
                review.blocking && `${review.blocking} blocking`,
                review.suggestions && plural(review.suggestions, 'suggestion'),
              ]
                .filter(Boolean)
                .join(' · ') || 'no findings'}
            </small>
          </>
        ) : reviewing ? (
          <Running />
        ) : (
          <span className="cell-state muted">{gates?.state === 'failed' ? 'Not reviewed' : 'Waiting'}</span>
        )}
      </div>
      {a.returned && (
        <>
          <span />
          <div className="ret-row">
            {/* The arc joins two rows: a return the coder declined in full, or one the work item closed after, has no
                row after it to reach. */}
            {followed && !a.returned.declined && (
              <>
                <svg className="arc" viewBox="0 0 300 54" preserveAspectRatio="none" aria-hidden="true">
                  <path className="ret-arc" d={`M${from} 0 C${from} 34 50 18 50 52`} />
                </svg>
                <svg className="head" viewBox="0 0 12 10" aria-hidden="true">
                  <path d="M1.5 1.5 6 8.5 10.5 1.5" />
                </svg>
              </>
            )}
            <span className="pill ret-pill">
              <Glyph name="back" />
              {capital(a.returned.from)} → Build · {a.returned.detail}
            </span>
          </div>
        </>
      )}
    </>
  );
}

/**
 * A visitor's report, or the planner's finding: where it came from, and that its words are withheld. For Martin, what
 * each visitor (or the planner) wrote is quoted under it: only the full events carry it, made plain and short (`reportText`), and React
 * inserts it as text. A report's text is kept for `REPORT_KEPT_DAYS` days, and none is quoted after.
 */
function Report({ report }: { report: NonNullable<SheetData['report']> }) {
  const withheld =
    report.by === 'planner' ? (
      <p className="report raised withheld">
        {report.times > 1
          ? `The planner’s findings on ${report.page}, ${report.times} of them, each noticed while it planned another ticket. Their words are untrusted, as a visitor’s are, so they are shown only to Martin; what triage made of them is below.`
          : `The planner’s finding on ${report.page}, noticed while it planned another ticket. Its words are untrusted, as a visitor’s are, so they are shown only to Martin; what triage made of them is below.`}
      </p>
    ) : report.quarantined ? (
      <p className="report raised withheld">
        A visitor’s report from {report.page}. It gave orders to the system, so it is quarantined. Its text is kept for{' '}
        {REPORT_KEPT_DAYS} days, and shown only to Martin and to the visitor who sent it.
      </p>
    ) : (
      <p className="report raised withheld">
        A visitor’s report from {report.page}. Its text is kept for {REPORT_KEPT_DAYS} days, shown only to the visitor
        who sent it and to Martin; what triage made of it is below.
      </p>
    );
  if (!report.texts.length) return withheld;
  return (
    <div className="report-own">
      {withheld}
      <ReportTexts texts={report.texts} by={report.by} />
    </div>
  );
}

function ReportTexts({ texts, by }: { texts: string[]; by: 'visitor' | 'planner' }) {
  const caption =
    by === 'planner'
      ? 'Only you see this: the planner wrote it'
      : texts.length > 1
        ? 'Only you see these: visitors wrote them'
        : 'Only you see this: a visitor wrote it';
  return (
    <figure className="report-said">
      <figcaption>{caption}</figcaption>
      {texts.map((text, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the reports keep their order, and two may say the same
        <blockquote key={i}>
          <q>{text}</q>
        </blockquote>
      ))}
    </figure>
  );
}

/**
 * The review thread: each review as the reviewer posted it, and each finding with where it is, whether it blocks, what
 * it says and the rule it cites, in full. Blocking is solid ink and a suggestion dashed; a finding still blocking
 * when the work is held for Martin turns ember, because then a person must act on it.
 */
function ReviewThread({ reviews, start, open }: { reviews: ThreadReview[]; start: number; open: boolean }) {
  return reviews.map((r, i) => (
    <div className="round" key={r.number}>
      <div className="round-h">
        <span>
          <b>Review {r.number}</b> · {VERDICT[r.verdict].toLowerCase()}
        </span>
        <span className="mono muted">
          {sinceStart(r.at - start)}
          {r.attempt ? ` · attempt ${r.attempt}` : ''}
        </span>
      </div>
      <p className="note">{r.note}</p>
      {r.findings.length > 0 && (
        <ul className="remarks">
          {r.findings.map((f) => (
            <li className="remark raised" key={`${f.path}:${f.line}:${f.comment}`}>
              <div className="top">
                <span
                  className={`weight ${f.blocking ? 'blocking' : 'suggestion'} ${open && f.blocking && i === reviews.length - 1 ? 'open' : ''}`}
                >
                  {f.blocking ? 'Blocking' : 'Suggestion'}
                </span>
                <span className="where">
                  {f.path}:{f.line}
                </span>
              </div>
              <p>{f.comment}</p>
              {f.rule && (
                <div className="cites">
                  <span className="n">RULE {f.rule.number}</span>
                  {f.rule.title && <b>{f.rule.title}.</b>}
                  {f.rule.text && <span>{f.rule.text}</span>}
                </div>
              )}
              {f.ticket && (
                <div className="cites">
                  <span className="n">TICKET</span>
                  <span>Beyond what the ticket asks: the coder cannot put a spec right, so Martin decides.</span>
                </div>
              )}
              {f.criterion && (
                <div className="cites">
                  <span className="n">CRITERION {f.criterion.number}</span>
                  {f.criterion.text && <span>{f.criterion.text}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  ));
}

/** Who saw a ticket's problem: every sense, in the order they first saw it, and those that haven't yet. */
function SeenBy({ rows }: { rows: Sighting[] }) {
  return (
    <div className="side-card raised seen-by">
      <h3>Seen by</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.sense} className={row.at === undefined ? 'unseen' : ''}>
            <span className="label">{SENSE[row.sense].group}</span>
            <span>
              {row.check ? capital(row.check) : 'None yet'}
              {(row.opened || row.added) && <small>{row.opened ? 'opened the ticket' : row.added}</small>}
              {row.again && <small>{seenAgain(row.again)}</small>}
            </span>
            <span className="mono">{row.at !== undefined ? clock(row.at) : ''}</span>
          </li>
        ))}
      </ul>
      <p className="help">
        Each sense adds its evidence the first time it sees the problem in each version. After that the inbox counts it.
      </p>
    </div>
  );
}

/** A sense's later sightings: "again in 4f9c2e1 at 17:43", or with how many versions: "again in 2 versions, lately …". */
const seenAgain = ({ versions, at }: NonNullable<Sighting['again']>) =>
  `again in ${versions.length > 1 ? `${versions.length} versions, lately ` : ''}${shortVersion(versions.at(-1) ?? '')} at ${clock(at)}`;

function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="sec">
      <h3>{title}</h3>
      <p className="help">{help}</p>
      {children}
    </section>
  );
}

/** An evidence block's last line: where the factory got it, after the marks of the tools that made it. */
function Source({ tools = [], children }: { tools?: readonly ToolName[] | undefined; children: ReactNode }) {
  return (
    <p className="source">
      {[...new Set(tools)].map((tool) => (
        <ToolMark key={tool} name={tool} />
      ))}
      <span>{children}</span>
    </p>
  );
}

/**
 * The app's version: a commit by its short form, linked to the commit and with the whole of it on hover. A sample's
 * commit never existed, so it links nowhere.
 */
function Version({ version, sample }: { version: string; sample: boolean }) {
  if (!isCommit(version)) return version;
  const short = shortVersion(version);
  if (sample) return <span title={version}>{short}</span>;
  return (
    <a href={`${APP_REPO}/commit/${version}`} title={version}>
      {short}
    </a>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

const SIDE_TAG: Record<string, [string, 'attn' | 'ok' | 'faint' | 'signal']> = {
  before: ['BEFORE', 'faint'],
  broken: ['BROKEN', 'attn'],
  canary: ['CANARY', 'signal'],
  fixed: ['FIXED', 'ok'],
  after: ['AFTER', 'ok'],
};

/**
 * The stage scrubber: a chapter per step, the events up to the chosen one, and the site as it stood then. A pass after
 * the first is one chapter until it holds the chosen one (`scrubbed`); the events are the last five, or all of them.
 */
function Replay({ chapters, motion }: { chapters: Chapter[]; motion: boolean }) {
  const last = chapters.length - 1;
  const [at, setAt] = useState(last);
  const [playing, setPlaying] = useState(false);
  const [all, setAll] = useState(false);
  // The scrubber's width decides how many chapters keep a target's width apart; it is measured when it changes.
  const [scrub, width] = useMeasured(TARGET * 13, (box) => box.width);
  const chapter = chapters[Math.min(at, last)];
  const start = chapters[0]?.at ?? 0;

  useEffect(() => {
    if (!playing) return;
    if (at >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setAt((a) => a + 1), 1200);
    return () => clearTimeout(timer);
  }, [playing, at, last]);

  if (!chapter) return null;
  const site = chapter.site;
  const [tag, tone] = site ? (SIDE_TAG[site.side] ?? ['', 'faint']) : ['', 'faint'];
  const events = chapters.slice(0, at + 1).filter((c) => c.actor);
  const listed = all ? events : events.slice(-5);
  // The clock and the events' times are as wide as the longest time they will show, in characters of their own mono,
  // so that the buttons beside the clock and the events' names stay put as the scrubber moves.
  const widest = (list: Chapter[]) => `${Math.max(0, ...list.map((c) => sinceStart(c.at - start).length))}ch`;
  const widths = { '--clock': widest(chapters), '--when': widest(chapters.filter((c) => c.actor)) } as CSSProperties;
  const shown = scrubbed(chapters, Math.min(at, last), width);
  const here = shown.findIndex((s) => at >= s.index && at < s.index + s.count);
  return (
    <div className={`replay ${site ? '' : 'solo'}`} style={widths}>
      {site && (
        <div className="site">
          <div className="site-head">
            <span className="label">
              The site at <span className="as-written">{sinceStart(chapter.at - start)}</span>
            </span>
            <span className={`label tone-${tone} toned`}>
              {tag} · {shortVersion(site.shot.version)}
            </span>
          </div>
          <div className="vis">
            <Shot shot={site.shot} />
          </div>
        </div>
      )}
      <div>
        <div className="ctl">
          <span className="clock">{sinceStart(chapter.at - start)}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous step"
            disabled={at === 0}
            onClick={() => {
              setPlaying(false);
              setAt(Math.max(0, at - 1));
            }}
          >
            <Glyph name="left" />
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!motion && at === last}
            onClick={() => {
              if (playing) return setPlaying(false);
              if (!motion) return setAt(last);
              if (at >= last) setAt(0);
              setPlaying(true);
            }}
          >
            {playing ? 'Pause' : at >= last ? 'Replay' : 'Play'}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next step"
            disabled={at >= last}
            onClick={() => {
              setPlaying(false);
              setAt(Math.min(last, at + 1));
            }}
          >
            <Glyph name="right" />
          </button>
        </div>
        <div className="scrub" ref={scrub}>
          <div className="rl" />
          <div className="fill" style={{ width: `${shown[here]?.left ?? 0}%` }} />
          {shown.map((s, j) => {
            const c = chapters[s.index] as Chapter;
            const label = s.pass ? `PASS ${s.pass}` : c.label;
            const name = s.pass
              ? `Pass ${s.pass}: ${s.count} steps, from ${sinceStart(c.at - start)}`
              : `${sinceStart(c.at - start)}, ${c.label.toLowerCase()}`;
            return (
              <button
                key={s.index}
                type="button"
                className={`ch tone-${s.pass ? 'faint' : c.tone} ${j === here ? 'here' : ''} ${j < here ? 'done' : ''} ${j % 2 ? 'odd' : ''} ${c.waiting && !s.pass ? 'waiting' : ''} ${s.pass ? 'pass' : ''} ${s.labelled ? '' : 'crowd'}`}
                style={{ left: `${s.left}%` }}
                aria-label={name}
                aria-current={j === here ? 'step' : undefined}
                onClick={() => {
                  setPlaying(false);
                  setAt(s.index);
                }}
              >
                <i />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <ol className="events">
          {listed.map((c, i) => (
            <li key={`${c.label}-${c.at}`} className={`event ${i === listed.length - 1 ? 'now' : ''}`}>
              <span className="mono when">{sinceStart(c.at - start)}</span>
              <span className="mono actor">{c.actor}</span>
              <span>{c.text}</span>
            </li>
          ))}
        </ol>
        {events.length > 5 && (
          <button type="button" className="btn all-events" onClick={() => setAll(!all)}>
            {all ? 'Fewer events' : `All events (${events.length})`}
          </button>
        )}
      </div>
    </div>
  );
}
