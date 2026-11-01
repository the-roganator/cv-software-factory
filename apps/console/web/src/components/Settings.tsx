/**
 * The settings (`?view=settings`): each agent's model and effort and the spend caps, within the bounds policy sets for
 * the profile, the line's controls, and for Martin his passkeys and this session. "Settings" from his account menu,
 * "Models and spend" for a visitor, who sees the models, the caps and the line's controls read only, and who changes
 * them.
 *
 * The line's controls are Controls' own (`LineControls`), not a copy: each change acts at once, with no draft, and
 * shows here and in Controls as its event arrives.
 *
 * What is in force comes from the events, through policy's own check (`projection/settings.ts`). A change is a draft
 * until saved: each changed field takes a `signal` rule, and the bar under the caps says what changes, in words, and
 * whether saving asks for the passkey. The admin service checks the save against policy again, and the gateway and
 * the line again as they read it; the page's check only keeps Martin from asking for what would be refused.
 */
import { EFFORTS, type Effort, MODEL_AGENTS, MODELS, type ModelAgent } from '@software-factory/policy/models';
import { CAP_NAMES, CAPS, type CapField, changesBetween, inForce } from '@software-factory/policy/settings';
import { CEILINGS } from '@software-factory/policy/spend';
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import { SETTINGS_STEP_UP } from '../access.ts';
import { type Admin, doorHref, post, type Session, said, write } from '../admin.ts';
import { capital, changeWords, clock, dayLabel, modelTitle, money, plural } from '../format.ts';
import type { ControlsView, SettingsView } from '../projection/index.ts';
import { KeyLegend, LineControls, SpendGroup } from './Controls.tsx';
import { Key, useStepUp } from './StepUp.tsx';
import '../styles/settings.css';

/** What each agent does, in a line. */
const DOES: Record<ModelAgent, string> = {
  planner: 'Writes the spec from the ticket',
  coder: 'Writes the test, then the fix',
  reviewer: 'Reviews what passed the gates',
  describer: 'Writes the pull request’s story',
};

const CAP_ROWS: { cap: CapField; label: string; note: string; spent: (view: SettingsView) => string }[] = [
  {
    cap: 'dayUsd',
    label: 'Each day',
    note: 'UTC, reset at 00:00',
    spent: (v) => `${money(v.spend.today.spentUsd)} today`,
  },
  {
    cap: 'monthUsd',
    label: 'Each month',
    note: 'UTC calendar month; empty for none, where policy allows',
    spent: (v) => `${money(v.spend.month.spentUsd)} this month`,
  },
  {
    cap: 'workItemUsd',
    label: 'Each work item',
    note: 'Across all its calls',
    spent: (v) =>
      v.spend.dearest
        ? `the dearest today, #${v.spend.dearest.workItem}, ${money(v.spend.dearest.spentUsd)}`
        : 'nothing spent on a work item today',
  },
];

/** A cap as its field shows it: 20, 1.50, or nothing for none. */
const capText = (usd: number | null) => (usd === null ? '' : Number.isInteger(usd) ? String(usd) : usd.toFixed(2));

/** A cap's field as a figure: none when empty, and not a number when it is not one. */
const capOf = (text: string): number | null => (text.trim() === '' ? null : Number(text.trim()));

interface Draft {
  agents: Partial<Record<ModelAgent, { model?: string; effort?: Effort }>>;
  caps: Partial<Record<CapField, string>>;
}

const EMPTY: Draft = { agents: {}, caps: {} };

export function Settings({
  view,
  controls,
  allLocal,
  admin,
}: {
  view: SettingsView;
  controls: ControlsView;
  allLocal: boolean;
  admin: Admin;
}) {
  const session = admin.kind === 'martin' ? admin.session : undefined;
  const martin = session !== undefined;
  const { profile, settings } = view;
  const policy = MODELS[profile];
  const ceilings = CEILINGS[profile];
  const stepUp = useStepUp();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // A save, this page's or another's, starts the draft again from what is now in force: a draft left over would undo
  // a newer setting.
  const lastSaved = view.last?.seq;
  useEffect(() => {
    if (lastSaved !== undefined) setDraft(EMPTY);
  }, [lastSaved]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  // What the page asks for: what is in force, with the draft on top. A local model in force has no effort to keep, so
  // a move to Claude starts at the agent's default.
  const asked = useMemo(() => {
    const agents = Object.fromEntries(
      MODEL_AGENTS.map((agent) => {
        const now = settings.agents[agent];
        const model = draft.agents[agent]?.model ?? now.model;
        const effort =
          draft.agents[agent]?.effort ?? (now.provider === 'local' ? policy.agents[agent].default.effort : now.effort);
        // A local model takes no effort: LM Studio sets it.
        const local = policy.models.find((m) => m.model === model)?.provider === 'local';
        return [agent, local ? { model } : { model, effort }];
      }),
    );
    const caps = Object.fromEntries(
      CAPS.map((cap) => [cap, draft.caps[cap] === undefined ? settings.caps[cap] : capOf(draft.caps[cap] ?? '')]),
    );
    return { agents, caps };
  }, [draft, settings, policy]);
  const after = useMemo(() => inForce(profile, asked), [profile, asked]);
  // A cap the page cannot take: not a figure, or outside its bounds. A month's may be empty where policy has none.
  const badCaps = CAPS.filter((cap) => draft.caps[cap] !== undefined && after.outside.includes(`caps.${cap}`));
  const { changes, actions } = useMemo(() => changesBetween(profile, settings, after), [profile, settings, after]);
  const raises = actions.some((action) => SETTINGS_STEP_UP[action]);
  const changed = (field: string) =>
    changes.some((c) => (c.field === 'cap' ? `cap:${c.cap}` : `${c.field}:${c.agent}`) === field);

  const setAgent = (agent: ModelAgent, part: 'model' | 'effort') => (event: ChangeEvent<HTMLSelectElement>) =>
    setDraft((d) => ({
      ...d,
      agents: { ...d.agents, [agent]: { ...d.agents[agent], [part]: event.currentTarget.value } },
    }));
  const setCap = (cap: CapField) => (event: ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, caps: { ...d.caps, [cap]: event.currentTarget.value } }));

  const save = async () => {
    if (!session || busy || badCaps.length || !changes.length) return;
    setBusy(true);
    setRefusal(undefined);
    const agents: Record<string, { model?: string; effort?: string }> = {};
    const caps: Record<string, number | null> = {};
    for (const change of changes) {
      if (change.field === 'cap') {
        const cap = CAPS.find((field) => CAP_NAMES[field] === change.cap) as CapField;
        caps[cap] = after.caps[cap];
        continue;
      }
      const model = after.agents[change.agent];
      agents[change.agent] = {
        model: model.model,
        ...(model.provider !== 'local' && { effort: model.effort }),
      };
    }
    let cancelled = false;
    const ask = async () => {
      cancelled = !(await stepUp.ask({
        title: 'Save the settings',
        what: (
          <>
            <b>{capital(changes.map(changeWords).join('; '))}</b>, from each agent’s next step.
          </>
        ),
        why: 'This raises spend',
      }));
      return !cancelled;
    };
    const got = await write(
      '/admin/settings',
      { ...(Object.keys(agents).length && { agents }), ...(Object.keys(caps).length && { caps }) },
      session.token,
      ask,
    );
    setBusy(false);
    if (cancelled) return;
    // Saved: the draft stays until the event arrives, and then starts again from what is in force.
    if (got.status !== 200) setRefusal(said(got));
  };

  const readOnly = !martin;
  const modelsPanel = (
    <article className="panel" aria-labelledby="models-title">
      <div className="panel-head">
        <h2 id="models-title">Models</h2>
        {readOnly && <span className="label">Read only</span>}
      </div>
      <p className="help">
        Each agent’s model and effort, within the bounds <code>policy/models.ts</code> sets for this profile.{' '}
        {policy.local
          ? `${modelTitle(policy.local.model)} runs on Martin’s Mac, for nothing.`
          : 'This profile has no local model.'}{' '}
        A change applies from an agent’s next step: a step running now finishes on what it started with, and records
        what it ran on.
      </p>
      {allLocal && (
        <p className="settings-note">
          The gateway sends every agent to {modelTitle(policy.local?.model ?? 'the local model')} for now (
          <code>ALL_LOCAL</code>), whatever is chosen here.
        </p>
      )}
      <table className="agents">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Model</th>
            <th>Effort</th>
            <th className="num">Spent</th>
          </tr>
        </thead>
        <tbody>
          {MODEL_AGENTS.map((agent) => {
            const bounds = policy.agents[agent];
            const chosen = after.agents[agent];
            const local = chosen.provider === 'local';
            const max = EFFORTS.indexOf(bounds.maxEffort);
            const week = view.week[agent];
            const outside = outsideWords(view, agent);
            return (
              <tr key={agent}>
                <td>
                  <b>The {agent}</b>
                  <small>{DOES[agent]}</small>
                  {outside && <small className="settings-outside">{outside}</small>}
                </td>
                <td className={changed(`model:${agent}`) ? 'changed' : undefined}>
                  <label className="sr" htmlFor={`model-${agent}`}>
                    The {agent}’s model
                  </label>
                  <select
                    className="field"
                    id={`model-${agent}`}
                    value={chosen.model}
                    disabled={readOnly}
                    onChange={setAgent(agent, 'model')}
                  >
                    {policy.models
                      .filter((m) => bounds.models.includes(m.model))
                      .map((m) => (
                        <option key={m.model} value={m.model}>
                          {modelTitle(m.model)}
                          {m.provider === 'local' ? ' · local' : ''}
                        </option>
                      ))}
                  </select>
                </td>
                <td className={changed(`effort:${agent}`) ? 'changed' : undefined}>
                  <label className="sr" htmlFor={`effort-${agent}`}>
                    The {agent}’s effort
                  </label>
                  <select
                    className="field"
                    id={`effort-${agent}`}
                    value={local ? '' : chosen.effort}
                    disabled={readOnly || local}
                    onChange={setAgent(agent, 'effort')}
                  >
                    {local && <option value="">set in LM Studio</option>}
                    {EFFORTS.map((effort, i) => (
                      <option key={effort} value={effort} disabled={i > max}>
                        {effort}
                        {i > max ? ' · above policy' : ''}
                      </option>
                    ))}
                  </select>
                  <small>{local ? 'Effort is set in LM Studio' : `up to ${bounds.maxEffort}`}</small>
                </td>
                <td className="num">
                  {week.steps} {week.steps === 1 ? 'step' : 'steps'} · {money(week.usd)}
                  <br />
                  last 7 days
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="help">
        Triage is not here: it asks Jev typed questions, through the gateway, at a fraction of a cent each.
      </p>
    </article>
  );

  const capsPanel = (
    <article className="panel" aria-labelledby="caps-title">
      <div className="panel-head">
        <h2 id="caps-title">Spend caps</h2>
        {readOnly && <span className="label">Read only</span>}
      </div>
      <p className="help">
        At a cap the gateway refuses every call, and the agents stop. {readOnly ? 'Martin sets each' : 'Set each'}{' '}
        within its ceiling; a higher ceiling is a pull request to <code>policy/spend.ts</code>. Raising a cap asks for
        the passkey, and carries on the work it held.
      </p>
      <div className="caps">
        {CAP_ROWS.map(({ cap, label, note, spent }) => {
          const meter =
            cap === 'dayUsd' ? view.spend.today : cap === 'monthUsd' ? view.spend.month : view.spend.dearest;
          const capUsd = after.caps[cap];
          const share = meter && capUsd ? Math.min(100, (meter.spentUsd / capUsd) * 100) : 0;
          const outside = view.last && settings.outside.includes(`caps.${cap}`);
          return (
            <div
              key={cap}
              className={`cap-row${changed(`cap:${CAP_NAMES[cap]}`) || badCaps.includes(cap) ? ' changed' : ''}`}
            >
              <label htmlFor={`cap-${cap}`}>
                {label}
                <small>{note}</small>
                {outside && (
                  <small className="settings-outside">
                    Martin’s last setting is outside policy, so its default is in force.
                  </small>
                )}
              </label>
              <span className="money">
                <input
                  className="field"
                  id={`cap-${cap}`}
                  inputMode="decimal"
                  value={draft.caps[cap] ?? capText(settings.caps[cap])}
                  placeholder={cap === 'monthUsd' ? 'none' : undefined}
                  disabled={readOnly}
                  aria-invalid={badCaps.includes(cap) || undefined}
                  aria-describedby={`cap-${cap}-ceiling`}
                  onChange={setCap(cap)}
                />
              </span>
              <span className="ceil">
                <span className={`bar ink${capUsd === null ? ' none' : ''}`}>
                  <i className={meter?.atCap ? 'attn' : undefined} style={{ width: `${share}%` }} />
                </span>
                <span id={`cap-${cap}-ceiling`}>
                  {spent(view)} · ceiling {money(ceilings[cap])}, from policy/spend.ts
                  {badCaps.includes(cap) ? ' · a figure above nothing, up to the ceiling' : ''}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );

  const linePanel = (
    <article className="panel" aria-labelledby="line-title">
      <div className="panel-head">
        <h2 id="line-title">The line</h2>
        {readOnly && <span className="label">Read only</span>}
      </div>
      <LineControls controls={controls} admin={admin} />
      <p className="help">
        {readOnly ? (
          'Only Martin changes these, signed in with his passkey, and every change is an event for all to see.'
        ) : (
          <>
            Each change acts at once, with no Save, and shows in Controls too. <KeyLegend />
          </>
        )}
      </p>
    </article>
  );

  const pending = changes.length > 0 || badCaps.length > 0;
  const saveBar = martin && pending && (
    <div className="save-bar">
      <p>
        {badCaps.length
          ? 'Each cap is a figure in dollars above nothing, up to its ceiling.'
          : `${plural(changes.length, 'change')}: ${changes.map(changeWords).join('; ')}.${
              raises ? ' It raises spend, so saving asks for your passkey.' : ''
            }`}
      </p>
      <div className="row">
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setDraft(EMPTY);
            setRefusal(undefined);
          }}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn primary small"
          disabled={badCaps.length > 0}
          aria-disabled={busy || undefined}
          onClick={() => void save()}
        >
          Save
          {raises && !stepUp.fresh && <Key />}
        </button>
      </div>
      {refusal && (
        <p className="dialog-refusal" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );

  return (
    <div className="settings-page">
      <div className="settings-head">
        <a className="crumb" href="/">
          ← The console
        </a>
        <h1>{martin ? 'Settings' : 'Models and spend'}</h1>
        <p>
          {martin
            ? 'Models, spend and the line, within the bounds policy sets.'
            : 'What each agent runs on, what the factory may spend, and how the line runs. Martin chooses within the bounds policy sets; nobody can choose outside them.'}
        </p>
      </div>
      <div className="settings">
        <div className="settings-col">
          {modelsPanel}
          {capsPanel}
          {saveBar}
        </div>
        <div className="settings-col">
          {linePanel}
          {session ? (
            <>
              <Passkeys session={session} />
              <ThisSession session={session} />
            </>
          ) : (
            <article className="panel" aria-labelledby="whose-title">
              <h2 id="whose-title">Who changes these</h2>
              <p className="help">
                Martin, signed in with his passkey. Each change is an event, with what it was before, and the gateway
                checks every setting against policy as it reads it: one outside the bounds has no effect.
              </p>
              <SpendGroup spend={view.spend} />
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

/** How long a session lasts, in minutes, from its own times: the store sets them, whatever this image was built with. */
const lasts = (session: Session) =>
  Math.round((Date.parse(session.expiresAt) - Date.parse(session.signedInAt)) / 60_000);

/** What Martin last chose for an agent that policy does not allow now, in words; nothing when all of it is in force. */
function outsideWords(view: SettingsView, agent: ModelAgent): string | undefined {
  if (!view.last) return undefined;
  const fields = view.settings.outside.filter((field) => field.startsWith(`${agent}.`));
  if (!fields.length) return undefined;
  const what = fields.map((field) => field.slice(agent.length + 1)).join(' and ');
  return `Martin’s last ${what} for it is outside policy, so its default is in force.`;
}

/** Martin's passkeys: each with when it was enrolled and last used, which is this device's, and Revoke. */
function Passkeys({ session }: { session: Session }) {
  const stepUp = useStepUp();
  const [held, setHeld] = useState(session.passkeys);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const revoke = async (passkey: Session['passkeys'][number]) => {
    if (busy) return;
    setBusy(true);
    setRefusal(undefined);
    let cancelled = false;
    const ask = async () => {
      cancelled = !(await stepUp.ask({
        title: `Revoke ${passkey.name}`,
        what: (
          <>
            <b>{passkey.name} can no longer sign in</b>, and every session it signed in ends
            {passkey.current ? ', this one among them' : ''}.
          </>
        ),
        why: 'Revoking a passkey changes who can sign in',
      }));
      return !cancelled;
    };
    const got = await write(`/admin/passkeys/${encodeURIComponent(passkey.id)}/revoke`, {}, session.token, ask);
    setBusy(false);
    if (cancelled) return;
    if (got.status !== 200) return setRefusal(said(got));
    if (got.body?.signedOut === true) return location.assign(doorHref('sign-in', 'here'));
    setHeld((keys) => keys.filter((key) => key.id !== passkey.id));
  };
  return (
    <article className="panel" aria-labelledby="keys-title">
      <h2 id="keys-title">Passkeys</h2>
      <div className="keys">
        {held.map((passkey) => (
          <div key={passkey.id}>
            <span>
              {passkey.name}
              <small>
                Enrolled {dayLabel(Date.parse(passkey.enrolledAt))}
                {passkey.lastUsedAt
                  ? ` · used ${dayLabel(Date.parse(passkey.lastUsedAt))}, ${clock(Date.parse(passkey.lastUsedAt))}`
                  : ''}
                {passkey.current ? ' · this device' : ''}
              </small>
            </span>
            <button
              type="button"
              className="btn small"
              aria-disabled={busy || undefined}
              onClick={() => void revoke(passkey)}
            >
              Revoke<span className="sr"> {passkey.name}</span>
              {!stepUp.fresh && <Key />}
            </button>
          </div>
        ))}
      </div>
      <p className="help">
        Two at most. Each is added with <code>factory admin enrol</code> on the command line, never from here.
      </p>
      {refusal && (
        <p className="dialog-refusal" role="alert">
          {refusal}
        </p>
      )}
    </article>
  );
}

/** This session: when it started, with which passkey, when it ends, and signing out here or everywhere. */
function ThisSession({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const signOut = async (everywhere: boolean) => {
    setBusy(true);
    setRefusal(undefined);
    const got = await post(everywhere ? '/admin/sign-out-everywhere' : '/admin/sign-out', {}, session.token);
    if (got.status === 200 || got.status === 401) {
      location.assign(doorHref('sign-in', got.status === 200 && everywhere ? 'everywhere' : 'here'));
      return;
    }
    setBusy(false);
    setRefusal(said(got));
  };
  return (
    <article className="panel" aria-labelledby="session-title">
      <h2 id="session-title">This session</h2>
      <p className="help">
        Signed in at {clock(Date.parse(session.signedInAt))} with {session.passkey.name}’s passkey. It ends at{' '}
        {clock(Date.parse(session.expiresAt))}: {lasts(session)} minutes, however busy.
      </p>
      <div className="row">
        <button type="button" className="btn small" disabled={busy} onClick={() => void signOut(false)}>
          Sign out
        </button>
        <button type="button" className="btn small" disabled={busy} onClick={() => void signOut(true)}>
          Sign out everywhere
        </button>
      </div>
      {refusal && (
        <p className="dialog-refusal" role="alert">
          {refusal}
        </p>
      )}
    </article>
  );
}
