/**
 * Controls, the right of the bottom row, beside Needs you (`NeedsYou.tsx`), for everyone: the line's controls
 * (Autonomy, Switches, What the line takes), Alerts, the feature flags (`Flags.tsx`), then Spend, a key to the key, and
 * links to the settings and the audit log.
 * The settings page draws the line's controls (`LineControls`) and Spend from here too.
 *
 * The line's controls are Martin's, in force as the latest `controls.changed` and policy's check say
 * (`projection/controls.ts`). Each change is one write to the admin service (`POST /admin/line/controls`), which
 * decides from what is in force whether it loosens, and so asks for the passkey again; the key is drawn where it will.
 * What a change did shows as its event arrives: the control moves. A visitor, or Martin previewing as one, sees every
 * control in its read-only form: the choice filled, a switch's track faded, nothing to press.
 *
 * Alerts is one switch, whether alerts reach Martin's phone (`policy/phone.ts`): his latest `alerts.switched`, or the
 * profile's default, off on the laptop. Each switch is one write (`POST /admin/alerts/phone`); off asks for the
 * passkey again.
 *
 * Spend is three meters in ink, since spend is no fault: the models today against the day's cap, this month against
 * the month's, and the dearest work item today against a work item's cap, with when the day resets, in UTC. A meter at
 * its cap turns `attn`.
 */
import { type Autonomy, AUTONOMY as LEVELS, TAKES as LOOSEST_FIRST, type TakeKind } from '@software-factory/events';
import { type ControlChange, controlAction, TAKE, type Take } from '@software-factory/policy/line';
import { phoneInForce } from '@software-factory/policy/phone';
import type { Profile } from '@software-factory/policy/spend';
import { type ReactNode, useId, useState } from 'react';
import { CONTROL_STEP_UP, PHONE_STEP_UP } from '../access.ts';
import type { Admin } from '../admin.ts';
import { AUTONOMY, money, shortWhen } from '../format.ts';
import type { HeldAnswer } from '../held.ts';
import type { ControlsView, FlagsView, Meter, SpendView } from '../projection/index.ts';
import { FlagsGroup } from './Flags.tsx';
import { Glyph } from './Glyph.tsx';
import { type Asked, Key } from './StepUp.tsx';
import { Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

function SpendMeter({ label, meter, note }: { label: string; meter: Meter; note?: string }) {
  const share = meter.capUsd ? Math.min(100, (meter.spentUsd / meter.capUsd) * 100) : 0;
  return (
    <div className="meter">
      <div className="meter-figures">
        <span>
          {label}
          {note && <span className="muted"> {note}</span>}
        </span>
        <span className="mono">
          {money(meter.spentUsd)}{' '}
          <span className="muted">{meter.capUsd === null ? 'no cap' : `of ${money(meter.capUsd)}`}</span>
          {meter.atCap && <span className="sr">, at the cap</span>}
        </span>
      </div>
      {meter.capUsd !== null && (
        // The figures say it in words; the bar draws them.
        <span className="bar ink" aria-hidden="true">
          <i className={meter.atCap ? 'attn' : undefined} style={{ width: `${share}%` }} />
        </span>
      )}
    </div>
  );
}

/** The Spend group: the three meters, as Controls and the settings page draw them. */
export function SpendGroup({ spend }: { spend: SpendView }) {
  return (
    <div className="ctl-group">
      <span className="label">
        <span>Spend</span>
        <span>resets at 00:00 UTC</span>
      </span>
      <SpendMeter label="Models today" meter={spend.today} />
      <SpendMeter label="This month" meter={spend.month} />
      {spend.dearest ? (
        <SpendMeter label="Dearest work item today" note={`#${spend.dearest.workItem}`} meter={spend.dearest} />
      ) : (
        <p className="help">No work item has spent anything on models today.</p>
      )}
    </div>
  );
}

/** Who a line is said to: Martin, signed in, or anyone else, who reads of him. */
type Viewer = 'martin' | 'visitor';

/** What each autonomy level means, to Martin and to anyone else. */
const MEANS: Record<Autonomy, Record<Viewer, string>> = {
  supervised: {
    martin: 'You approve every merge and every release.',
    visitor: 'Martin approves every merge and every release.',
  },
  guarded: {
    martin: 'Low-risk changes ship on their own. Anything risky waits for you.',
    visitor: 'Low-risk changes ship on their own. Anything risky waits for Martin.',
  },
  'lights-out': {
    martin: 'Only the gates and the canary decide. You are told afterwards.',
    visitor: 'Only the gates and the canary decide. Martin is told afterwards.',
  },
};

/** Until approval routing comes (Part C), the autonomy level and auto-merge are recorded, and route nothing. */
const RECORDED: Record<Viewer, string> = {
  martin: 'Recorded: until approval routing comes, every merge waits for you.',
  visitor: 'Recorded: until approval routing comes, every merge waits for Martin.',
};

const TAKE_LABEL: Record<TakeKind, string> = {
  every: 'Every ticket',
  'next-few': 'The next few',
  'just-one': 'Just one',
};

/**
 * What the line takes, tightest first, as Autonomy's levels are: the key sits on each choice looser than the one in
 * force. The vocabulary lists them loosest first.
 */
const TAKES: readonly TakeKind[] = [...LOOSEST_FIRST].reverse();

/** What the line will do with a take, in a sentence. */
function takeWords(take: Take | null, nextFew: ControlsView['nextFew'], viewer: Viewer): string {
  if (!take) {
    return viewer === 'martin'
      ? 'Not set here: the line takes what its Deployment says (LINE_TAKE, LINE_ONLY). Choosing one asks for your passkey.'
      : 'Not set from the console: the line takes what its Deployment says.';
  }
  switch (take.kind) {
    case 'every':
      return 'The oldest open ticket of the highest severity, one after another, then each improvement Martin asked for, oldest first, for as long as the line runs.';
    case 'next-few': {
      const many = take.count === 1 ? 'The next work item' : `The next ${take.count} work items`;
      const since = nextFew?.since ?? Date.parse(take.since);
      return `${many} from ${shortWhen(since)}, then nothing new: ${nextFew?.taken ?? 0} taken so far, each carried to its end.`;
    }
    case 'just-one':
      return `Only #${take.workItem} moves, one step at a time. Every other work item stays where it is.`;
  }
}

/** A take as Martin sends it: the admin service stamps when the next few start. */
type TakeBody = { kind: 'every' } | { kind: 'next-few'; count: number } | { kind: 'just-one'; workItem: string };

/** What Martin may send: one change, as `POST /admin/line/controls` takes it, or a switch of alerts to his phone. */
type Change =
  | { autonomy: Autonomy }
  | { newWork: boolean }
  | { autoMerge: boolean }
  | { autoRollback: boolean }
  | { take: TakeBody }
  | Phone;
type Phone = { phone: boolean };

/** A wider take, as the passkey's dialog says it. */
const takeAsked = (take: Take) =>
  take.kind === 'every'
    ? 'The line takes every ticket, and each improvement after them.'
    : take.kind === 'next-few'
      ? `The line takes the next ${take.count === 1 ? 'work item' : `${take.count} work items`}, counted from now.`
      : `The line takes only #${take.workItem}.`;

/** A group's place in the panel, so a refusal shows under the control that was pressed. */
type Where = 'autonomy' | 'switches' | 'take' | 'alerts';

/** Martin's writes from Controls: each change, its passkey asked for when the service asks, and a refusal kept. */
function useChange(admin: Admin) {
  const writes = useWrite(admin.kind === 'martin' ? admin.session.token : undefined);
  // Where the last change was pressed, so what the service said of it shows there.
  const [pressed, setPressed] = useState<Where | undefined>(undefined);
  const change = async (where: Where, body: Change, asked: Asked): Promise<boolean> => {
    if (admin.kind !== 'martin' || writes.busy) return false;
    setPressed(where);
    const path = where === 'alerts' ? '/admin/alerts/phone' : '/admin/line/controls';
    return (await writes.send(path, body, { passkey: asked })).kind === 'done';
  };
  /** What the service said of the last change, if it was pressed in this group. */
  const said = (where: Where) => (pressed === where ? writes.refusal : undefined);
  return { busy: writes.busy, said, change, fresh: writes.fresh };
}

type Changer = ReturnType<typeof useChange>;

/** Whether a change asks for the passkey again, as the access table says of the action it is. */
const asks = (change: ControlChange) => CONTROL_STEP_UP[controlAction(change)];

function AutonomyGroup({ controls, viewer, changer }: { controls: ControlsView; viewer: Viewer; changer: Changer }) {
  const id = useId();
  const { autonomy } = controls;
  const martin = viewer === 'martin';
  return (
    <div className="ctl-group">
      <span className="label" id={`${id}-autonomy`}>
        <span>Autonomy</span>
      </span>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset needs a legend, and the group's label is above it */}
      <div className={`seg ${martin ? '' : 'ro-seg'}`} role="group" aria-labelledby={`${id}-autonomy`}>
        {LEVELS.map((level) => {
          const change: ControlChange = { control: 'autonomy', before: autonomy, after: level };
          return (
            <button
              key={level}
              type="button"
              aria-pressed={level === autonomy}
              disabled={!martin}
              aria-disabled={(martin && changer.busy) || undefined}
              onClick={() => {
                if (level === autonomy) return;
                void changer.change(
                  'autonomy',
                  { autonomy: level },
                  {
                    title: asks(change) ? 'Loosen autonomy' : 'Tighten autonomy',
                    what: (
                      <>
                        <b>The line runs at {AUTONOMY[level]}.</b> {MEANS[level].martin} {RECORDED.martin}
                      </>
                    ),
                    why: 'Loosening autonomy lets more ship without you',
                  },
                );
              }}
            >
              {AUTONOMY[level]}
              {martin && !changer.fresh && level !== autonomy && asks(change) && <Key />}
            </button>
          );
        })}
      </div>
      {/* Every level's words, laid in one place, with only the chosen one shown: the box is as tall as the longest at
          any width, so nothing under it moves when the level changes. */}
      <p className="help means">
        {LEVELS.map((level) => (
          <span
            key={level}
            className={level === autonomy ? 'chosen' : undefined}
            aria-hidden={level !== autonomy || undefined}
          >
            {MEANS[level][viewer]}
            {level !== 'supervised' && <span className="recorded"> {RECORDED[viewer]}</span>}
          </span>
        ))}
      </p>
      <Refusal text={changer.said('autonomy')} />
    </div>
  );
}

function Switch({
  label,
  note,
  off = false,
  on,
  live,
  keyed,
  busy,
  onToggle,
}: {
  label: string;
  note: ReactNode;
  /** Its words say what is off that guards something: drawn darker than a note. */
  off?: boolean;
  on: boolean;
  /** Martin may press it; otherwise it is drawn read-only. */
  live: boolean;
  /** Pressing it asks for the passkey again. */
  keyed: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={on}
      disabled={!live}
      aria-disabled={(live && busy) || undefined}
      onClick={() => {
        if (!busy) onToggle();
      }}
    >
      <span>
        <span className="switch-what">
          {label}
          {keyed && <Key />}
        </span>
        <small className={off ? 'off' : undefined}>{note}</small>
      </span>
      <span className="track" aria-hidden="true" />
    </button>
  );
}

/**
 * What auto-rollback does, on and off, to Martin and to anyone else. The switch covers what the analysis judges of the
 * canary against its baseline, errors and latency; the journeys are a Job, which Argo Rollouts ends only passed or
 * failed, so a failed journeys check rolls a canary back whatever the switch says (`apps/factory/src/release/analysis.ts`).
 */
const ROLLBACK: Record<'on' | 'off', Record<Viewer, string>> = {
  on: {
    martin:
      'On: a canary the analysis judges bad rolls back by itself. Off, errors or latency judged bad would pause it for you instead.',
    visitor:
      'On: a canary the analysis judges bad rolls back by itself. Off, errors or latency judged bad would pause it for Martin instead.',
  },
  off: {
    martin:
      'Off: a canary whose errors or latency the analysis judges bad pauses for you, in Needs you, instead of rolling back. A failed journeys check still rolls it back, and Stop the line still aborts one.',
    visitor:
      'Off: a canary whose errors or latency the analysis judges bad pauses for Martin, in Needs you, instead of rolling back. A failed journeys check still rolls it back, and Stop the line still aborts one.',
  },
};

function SwitchesGroup({ controls, viewer, changer }: { controls: ControlsView; viewer: Viewer; changer: Changer }) {
  const martin = viewer === 'martin';
  const { newWork, autoMerge, autoRollback } = controls;
  const autoMergeOn: ControlChange = { control: 'auto-merge', before: autoMerge, after: !autoMerge };
  const autoRollbackOff: ControlChange = { control: 'auto-rollback', before: autoRollback, after: !autoRollback };
  return (
    <div className="ctl-group">
      <span className="label">
        <span>Switches</span>
      </span>
      <div className="switches">
        <Switch
          label="Agents take new work"
          note="Off: each agent finishes its step, and nothing new is started."
          on={newWork}
          live={martin}
          keyed={false}
          busy={changer.busy}
          onToggle={() =>
            void changer.change(
              'switches',
              { newWork: !newWork },
              {
                title: newWork ? 'Stop agents taking new work' : 'Let agents take new work',
                what: <b>Agents take new work: {newWork ? 'off' : 'on'}.</b>,
                why: 'The admin service asks for it',
              },
            )
          }
        />
        <Switch
          label="Auto-merge low-risk changes"
          note={
            <>
              A low-risk change merges once its gates and review pass.{' '}
              <span className="recorded">{RECORDED[viewer]}</span>
            </>
          }
          on={autoMerge}
          live={martin}
          keyed={martin && !changer.fresh && asks(autoMergeOn)}
          busy={changer.busy}
          onToggle={() =>
            void changer.change(
              'switches',
              { autoMerge: !autoMerge },
              autoMerge
                ? {
                    title: 'Turn off auto-merge',
                    what: <b>Auto-merge low-risk changes: off.</b>,
                    why: 'The admin service asks for it',
                  }
                : {
                    title: 'Turn on auto-merge',
                    what: (
                      <>
                        <b>Auto-merge low-risk changes: on.</b> {RECORDED.martin}
                      </>
                    ),
                    why: 'Auto-merge lets changes merge without you',
                  },
            )
          }
        />
        {/* Off overrides a guardrail, so it asks for the passkey again; on asks for nothing. */}
        <Switch
          label="Auto-rollback"
          note={ROLLBACK[autoRollback ? 'on' : 'off'][viewer]}
          off={!autoRollback}
          on={autoRollback}
          live={martin}
          keyed={martin && !changer.fresh && asks(autoRollbackOff)}
          busy={changer.busy}
          onToggle={() =>
            void changer.change(
              'switches',
              { autoRollback: !autoRollback },
              autoRollback
                ? {
                    title: 'Turn off auto-rollback',
                    what: (
                      <>
                        <b>Auto-rollback: off.</b> A canary whose errors or latency the analysis judges bad pauses for
                        you, in Needs you, instead of rolling back, until you promote or abort it. A failed journeys
                        check still rolls it back, and Stop the line still aborts one.
                      </>
                    ),
                    why: 'Turning auto-rollback off overrides a guardrail',
                  }
                : {
                    title: 'Turn on auto-rollback',
                    what: (
                      <>
                        <b>Auto-rollback: on. A canary the analysis judges bad rolls back by itself.</b> One already
                        paused for you stays paused until you promote or abort it.
                      </>
                    ),
                    why: 'The admin service asks for it',
                  },
            )
          }
        />
      </div>
      <Refusal text={changer.said('switches')} />
    </div>
  );
}

/** Alerts: whether they reach Martin's phone, every one at its level, or none. Only off asks for the passkey. */
function AlertsGroup({ on, viewer, changer }: { on: boolean; viewer: Viewer; changer: Changer }) {
  const martin = viewer === 'martin';
  return (
    <div className="ctl-group">
      <span className="label">
        <span>Alerts</span>
      </span>
      <div className="switches">
        <Switch
          label={martin ? 'Alerts to my phone' : 'Alerts to Martin’s phone'}
          note={DASHBOARD}
          on={on}
          live={martin}
          keyed={martin && !changer.fresh && on && PHONE_STEP_UP['phone.off']}
          busy={changer.busy}
          onToggle={() =>
            void changer.change(
              'alerts',
              { phone: !on },
              { title: 'Stop alerts to your phone', what: <b>{DASHBOARD}</b>, why: 'It keeps every page from you' },
            )
          }
        />
      </div>
      <Refusal text={changer.said('alerts')} />
    </div>
  );
}

const DASHBOARD = 'Off: none reaches the phone. Grafana’s Alerts dashboard still shows every one.';

/** How many the next few's field offers first. */
const FIRST_FEW = 3;

/** What Martin is choosing under What the line takes, before he sets it: how many, or which work item. */
type Draft = { kind: 'next-few'; count: string } | { kind: 'just-one'; workItem: string };

/** The take a draft would set, as the admin service would make it, or none while it is not one policy allows. */
function draftTake(draft: Draft, now: number): Take | undefined {
  if (draft.kind === 'next-few') {
    const count = Number(draft.count);
    if (!Number.isInteger(count) || count < 1 || count > TAKE.most) return undefined;
    // Whatever the number, they count again from now.
    return { kind: 'next-few', count, since: new Date(now).toISOString() };
  }
  const workItem = draft.workItem.trim().replace(/^#/, '');
  return /^[1-9]\d{0,8}$/.test(workItem) ? { kind: 'just-one', workItem } : undefined;
}

/** The take a button offers, as it would first set it: the next few at the field's first number. */
const offered = (kind: TakeKind): Take =>
  kind === 'every'
    ? { kind }
    : kind === 'next-few'
      ? { kind, count: FIRST_FEW, since: new Date().toISOString() }
      : { kind, workItem: '1' };

function TakeGroup({ controls, viewer, changer }: { controls: ControlsView; viewer: Viewer; changer: Changer }) {
  const martin = viewer === 'martin';
  const { take, nextFew } = controls;
  const id = useId();
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  // The field shows what is in force until Martin types: the next few's number, or the work item.
  const shown: Draft | undefined =
    draft ??
    (take?.kind === 'next-few'
      ? { kind: 'next-few', count: String(take.count) }
      : take?.kind === 'just-one'
        ? { kind: 'just-one', workItem: take.workItem }
        : undefined);
  const pressed = shown?.kind ?? take?.kind;
  const after = shown && draftTake(shown, Date.now());

  const set = async (next: Take) => {
    const body: TakeBody =
      next.kind === 'next-few'
        ? { kind: 'next-few', count: next.count }
        : next.kind === 'just-one'
          ? { kind: 'just-one', workItem: next.workItem }
          : { kind: 'every' };
    const done = await changer.change(
      'take',
      { take: body },
      {
        // The next few count again from now, fewer too: with some taken already, that may be more work.
        title: next.kind === 'next-few' ? 'Count the next few from now' : 'Take more work',
        what: <b>{takeAsked(next)}</b>,
        why:
          next.kind === 'next-few'
            ? 'Counting again may take more work, and raise spend'
            : 'Taking more work raises spend',
      },
    );
    if (done) setDraft(undefined);
  };

  return (
    <div className="ctl-group">
      <span className="label" id={`${id}-label`}>
        <span>What the line takes</span>
      </span>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset needs a legend, and the group's label is above it */}
      <div className={`seg ${martin ? '' : 'ro-seg'}`} role="group" aria-labelledby={`${id}-label`}>
        {TAKES.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={kind === pressed}
            disabled={!martin}
            aria-disabled={(martin && changer.busy) || undefined}
            onClick={() => {
              if (changer.busy) return;
              if (kind === 'every') {
                setDraft(undefined);
                if (take?.kind !== 'every') void set({ kind: 'every' });
                return;
              }
              if (kind === take?.kind) return setDraft(undefined);
              setDraft(
                kind === 'next-few'
                  ? { kind, count: String(FIRST_FEW) }
                  : { kind, workItem: take?.kind === 'just-one' ? take.workItem : '' },
              );
            }}
          >
            {TAKE_LABEL[kind]}
            {martin &&
              !changer.fresh &&
              kind !== take?.kind &&
              asks({ control: 'take', before: take, after: offered(kind) }) && <Key />}
          </button>
        ))}
      </div>
      <p className="help">{takeWords(take, nextFew, viewer)}</p>
      {martin && shown && (
        <form
          className="take-field"
          onSubmit={(event) => {
            event.preventDefault();
            if (after) void set(after);
          }}
        >
          <span className="take-input">
            <label htmlFor={`${id}-take`}>{shown.kind === 'next-few' ? 'How many' : 'Work item #'}</label>
            {shown.kind === 'next-few' ? (
              <input
                id={`${id}-take`}
                className="field mono"
                type="number"
                min={1}
                max={TAKE.most}
                step={1}
                value={shown.count}
                onChange={(event) => setDraft({ kind: 'next-few', count: event.currentTarget.value })}
              />
            ) : (
              <input
                id={`${id}-take`}
                className="field mono"
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                value={shown.workItem}
                onChange={(event) => setDraft({ kind: 'just-one', workItem: event.currentTarget.value })}
              />
            )}
          </span>
          {/* Set once he has typed: the number or the work item in force is what the line takes already. */}
          {draft && (
            <>
              <button type="submit" className="btn small" disabled={!after} aria-disabled={changer.busy || undefined}>
                Set
                {after && !changer.fresh && asks({ control: 'take', before: take, after }) && <Key />}
              </button>
              <button type="button" className="btn small" onClick={() => setDraft(undefined)}>
                Cancel
              </button>
              {!after && (
                <span className="help">
                  {draft.kind === 'next-few' ? `From 1 to ${TAKE.most}.` : 'A ticket’s or an improvement’s number.'}
                </span>
              )}
            </>
          )}
        </form>
      )}
      <Refusal text={changer.said('take')} />
    </div>
  );
}

/**
 * The line's controls: Autonomy, Switches and What the line takes, as Controls and the settings page draw them. Each
 * place keeps its own refusal and busy state; both read the same controls in force, so a change made in one shows in
 * the other as its event arrives.
 */
export function LineControls({ controls, admin }: { controls: ControlsView; admin: Admin }) {
  const viewer: Viewer = admin.kind === 'martin' ? 'martin' : 'visitor';
  const changer = useChange(admin);
  return (
    <>
      <AutonomyGroup controls={controls} viewer={viewer} changer={changer} />
      <SwitchesGroup controls={controls} viewer={viewer} changer={changer} />
      <TakeGroup controls={controls} viewer={viewer} changer={changer} />
    </>
  );
}

/** The key to the key, for Martin: what the glyph after a control means. */
export function KeyLegend() {
  return (
    <span className="legend">
      <Glyph name="key" className="glyph key" /> asks for your passkey again, unless you gave it in the last five
      minutes.
    </span>
  );
}

interface ControlsProps {
  /** The page's profile, whose default says whether alerts reach the phone before Martin switches them. */
  profile: Profile;
  spend: SpendView;
  controls: ControlsView;
  flags: FlagsView;
  admin: Admin;
  /** The app's origin, which a flag's preview opens. */
  app: string | undefined;
  /** Whether the app holds the flags as set. */
  held: HeldAnswer;
  /** The page's time. */
  now: number;
  onOpen: (item: string) => void;
  /** A flag was moved: the page asks again soon whether the app holds it. */
  onMoved: () => void;
}

export function Controls({ profile, spend, controls, flags, admin, app, held, now, onOpen, onMoved }: ControlsProps) {
  const martin = admin.kind === 'martin';
  const changer = useChange(admin);
  return (
    <article className="panel controls" aria-labelledby="controls-title">
      <div className="panel-head">
        <h2 id="controls-title">Controls</h2>
        {!martin && <span className="label">Read only</span>}
      </div>
      <LineControls controls={controls} admin={admin} />
      <AlertsGroup
        on={phoneInForce(profile, controls.phone)}
        viewer={martin ? 'martin' : 'visitor'}
        changer={changer}
      />
      <FlagsGroup flags={flags} admin={admin} app={app} held={held} now={now} onOpen={onOpen} onMoved={onMoved} />
      <SpendGroup spend={spend} />
      <p className="help">
        Gates, image signing and the egress fence are always on: they have no switch.
        {martin && (
          <>
            {' '}
            <KeyLegend />
          </>
        )}
      </p>
      <p className="help">
        {martin
          ? 'Each cap is yours to set within its ceiling in the settings. Raising one asks for your passkey again.'
          : 'Only Martin changes these, signed in with his passkey, and every change is an event for all to see.'}
      </p>
      <div className="links">
        <a href="?view=settings">{martin ? 'Settings' : 'Models and spend caps'}</a>
        <a href="?view=audit">Audit log</a>
      </div>
    </article>
  );
}
