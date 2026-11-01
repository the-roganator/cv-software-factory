/**
 * The audit log (`?view=audit`): every agent action, model call and admin action, newest first, the same for everyone.
 * Its events are always the public ones (`App.tsx` reads the public stream on this page, even for Martin), and each row
 * is drawn from `projection/audit.ts`; this only draws it, and keeps the filters, which live in the address so a
 * filtered log can be shared.
 *
 * The newest page shows first, and Show older adds the next. Once drawn, the oldest row shown holds the page where it
 * is, so rows that arrive join the top and nothing the reader has open below moves.
 */

import type { PublicEvent } from '@software-factory/events';
import type { Profile } from '@software-factory/policy/spend';
import { type ChangeEvent, useEffect, useMemo, useState } from 'react';
import { clockSeconds } from '../format.ts';
import {
  ACTOR_CHOICES,
  ACTOR_NAME,
  AUDIT_KINDS,
  type AuditFilter,
  type AuditKind,
  type AuditRow,
  auditRows,
  auditView,
} from '../projection/audit.ts';
import { Glyph, type GlyphName } from './Glyph.tsx';
import { ToolMark } from './Logos.tsx';
import '../styles/settings.css';
import '../styles/audit.css';

const KIND: Record<AuditKind, { glyph: GlyphName; name: string; chip: string }> = {
  admin: { glyph: 'person', name: 'Admin action', chip: 'Admin actions' },
  agent: { glyph: 'arrows', name: 'Agent action', chip: 'Agent actions' },
  model: { glyph: 'chip', name: 'Model call', chip: 'Model calls' },
};

/** The filters the address asks for: `actor`, `item` and `kinds` beside `view=audit`. */
function fromAddress(): AuditFilter {
  const params = new URLSearchParams(location.search);
  const actor = params.get('actor') ?? '';
  const kinds = params.get('kinds')?.split(',');
  return {
    actor: ACTOR_CHOICES.some((choice) => choice.value === actor) ? actor : '',
    item: (params.get('item') ?? '').replace(/[^0-9]/g, '').slice(0, 10),
    kinds: Object.fromEntries(
      AUDIT_KINDS.map((kind) => [kind, !kinds || kinds.includes(kind)]),
    ) as AuditFilter['kinds'],
  };
}

/** Writes the filters into the address, in place, so a reload or a shared link shows the same rows. */
function toAddress(filter: AuditFilter) {
  const params = new URLSearchParams(location.search);
  const set = (name: string, value: string) => (value ? params.set(name, value) : params.delete(name));
  set('actor', filter.actor);
  set('item', filter.item.replace(/[^0-9]/g, ''));
  const kinds = AUDIT_KINDS.filter((kind) => filter.kinds[kind]);
  // Every kind is the default, and none is said in so many words, so a link to an empty log stays empty.
  set('kinds', kinds.length === AUDIT_KINDS.length ? '' : kinds.join(',') || 'none');
  history.replaceState(history.state, '', `?${params}`);
}

interface Props {
  events: readonly PublicEvent[];
  t: number;
  profile: Profile;
  /** Whether the store has answered, so an empty log is empty and not still loading. */
  settled: boolean;
}

export function AuditLog({ events, t, profile, settled }: Props) {
  const rows = useMemo(() => auditRows(events, t, profile), [events, t, profile]);
  const [filter, setFilter] = useState<AuditFilter>(fromAddress);
  const [floor, setFloor] = useState<number | undefined>(undefined);
  const view = useMemo(() => auditView(rows, filter, t, floor), [rows, filter, t, floor]);

  // The first page drawn holds where it ends.
  useEffect(() => {
    if (floor === undefined && view.floor !== undefined) setFloor(view.floor);
  }, [floor, view.floor]);

  const change = (next: AuditFilter) => {
    setFilter(next);
    setFloor(undefined);
    toAddress(next);
  };

  return (
    <div className="audit-page">
      <div className="audit-head">
        <a className="crumb" href="/">
          ← The console
        </a>
        <h1>Audit log</h1>
        <p>
          Every agent action, model call and admin action, newest first. Everyone sees the same log, from each event’s
          public view: what a visitor wrote, and anything shaped like a secret, is left out.
        </p>
      </div>
      <search className="filters" aria-label="Filter the audit log">
        <div className="filter">
          <label className="label" htmlFor="audit-actor">
            Actor
          </label>
          <select
            className="field"
            id="audit-actor"
            value={filter.actor}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              change({ ...filter, actor: event.currentTarget.value })
            }
          >
            <option value="">Everyone</option>
            {ACTOR_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="filter">
          <label className="label" htmlFor="audit-item">
            Work item
          </label>
          <input
            className="field"
            id="audit-item"
            inputMode="numeric"
            placeholder="#1312"
            maxLength={11}
            value={filter.item}
            onChange={(event: ChangeEvent<HTMLInputElement>) => change({ ...filter, item: event.currentTarget.value })}
          />
        </div>
        <fieldset>
          <legend className="label">Kind</legend>
          <span className="chips">
            {AUDIT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="chip"
                aria-pressed={filter.kinds[kind]}
                onClick={() => change({ ...filter, kinds: { ...filter.kinds, [kind]: !filter.kinds[kind] } })}
              >
                <Glyph name={KIND[kind].glyph} />
                {KIND[kind].chip}
              </button>
            ))}
          </span>
        </fieldset>
      </search>
      <table className="audit">
        <caption aria-live="polite">
          {settled || events.length ? view.caption : 'Reading the events…'}
          {view.shown > 0 && ' Martin’s own actions are ruled on the left.'}
        </caption>
        <thead className="label">
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Actor</th>
            <th scope="col">Kind</th>
            <th scope="col">Work item</th>
            <th scope="col">What happened</th>
          </tr>
        </thead>
        {view.days.map((day) => (
          <tbody key={day.rows[0]?.seq}>
            <tr className="day label">
              <th scope="rowgroup" colSpan={5}>
                {day.label}
              </th>
            </tr>
            {day.rows.map((row) => (
              <Row key={row.seq} row={row} />
            ))}
          </tbody>
        ))}
        {view.shown === 0 && view.filtered && (
          <tbody>
            <tr className="none">
              <td colSpan={5}>Nothing matches. Each filter narrows the log: clear one to see more.</td>
            </tr>
          </tbody>
        )}
      </table>
      {view.older !== undefined && (
        <button type="button" className="btn small" onClick={() => setFloor(view.older)}>
          Show older
        </button>
      )}
    </div>
  );
}

function Row({ row }: { row: AuditRow }) {
  const kind = KIND[row.kind];
  return (
    <tr className={row.martin ? 'martin' : undefined}>
      <td className="audit-time">
        <time dateTime={new Date(row.at).toISOString()}>{clockSeconds(row.at)}</time>
      </td>
      <td className="who">{ACTOR_NAME[row.actor]}</td>
      <td>
        <span className="kindw">
          <Glyph name={kind.glyph} />
          {row.admission && <ToolMark name="kyverno" />}
          <span>{kind.name}</span>
        </span>
      </td>
      <td className="item">
        {row.item ? (
          <a href={`/?item=${encodeURIComponent(row.item)}&sheet`}>#{row.item}</a>
        ) : (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr">none</span>
          </>
        )}
      </td>
      <td className={row.refused ? 'audit-what refused' : 'audit-what'}>
        {row.what}
        {row.detail && <small>{row.detail}</small>}
        {row.withheld && <small className="withheld">{row.withheld}</small>}
      </td>
    </tr>
  );
}
