/**
 * Martin's account button, at the right of the header while he is signed in, and its menu: who is signed in, since
 * when and until when; the settings, the audit log and Preview as visitor; this deployment's Grafana and Argo CD, each
 * in a new tab, when the admin service names them; Paper or Ink and Motion or Still; then signing out here or
 * everywhere. Escape or a click outside closes it.
 */
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { type Session, toolLink } from '../admin.ts';
import { clock } from '../format.ts';
import { StepUpLine } from './StepUp.tsx';
import type { Tool } from './ToolLogos.tsx';
import { Refusal } from './Words.tsx';
import { useSignOut } from './Write.tsx';

/** The tools' logos arrive only for a menu that has a tool to show. */
const ToolLogo = lazy(() => import('./ToolLogos.tsx').then((module) => ({ default: module.ToolLogo })));

const TOOLS: { key: Tool; name: string }[] = [
  { key: 'grafana', name: 'Grafana' },
  { key: 'argocd', name: 'Argo CD' },
];

export function Account({
  session,
  onPreview,
  switches,
}: {
  session: Session;
  onPreview: () => void;
  /** The theme and motion switches, which are in the menu while he is signed in. */
  switches: ReactNode;
}) {
  const tools = TOOLS.flatMap((tool) => {
    const link = toolLink(session.tools?.[tool.key]);
    return link ? [{ ...tool, ...link }] : [];
  });
  const [open, setOpen] = useState(false);
  const { busy, refusal, signOut } = useSignOut(session.token);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="account" ref={root}>
      <button
        type="button"
        className="account-btn"
        ref={button}
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
      >
        <span className="me" aria-hidden="true">
          M
        </span>
        <span className="name">Martin</span>
      </button>
      <div className="menu" id="account-menu" hidden={!open}>
        <div className="who">
          Martin Rogan
          <small>
            Signed in with a passkey at {clock(Date.parse(session.signedInAt))}
            <br />
            The session ends at {clock(Date.parse(session.expiresAt))}
            <StepUpLine />
          </small>
        </div>
        <a href="?view=settings">Settings</a>
        <a href="?view=audit">Audit log</a>
        <button type="button" onClick={onPreview}>
          Preview as visitor
        </button>
        {tools.length > 0 && <hr />}
        {tools.map((tool) => (
          <a key={tool.key} className="tool" href={tool.href} target="_blank" rel="noopener">
            <Suspense fallback={<span className="logo" aria-hidden="true" />}>
              <ToolLogo name={tool.key} />
            </Suspense>
            {tool.name}
            <small className="after">
              {tool.host}
              <span className="sr"> (opens in a new tab)</span>
            </small>
          </a>
        ))}
        <hr />
        {switches}
        <hr />
        <button type="button" disabled={busy} onClick={() => void signOut(false)}>
          Sign out
        </button>
        <button type="button" disabled={busy} onClick={() => void signOut(true)}>
          Sign out everywhere <small className="after">every device</small>
        </button>
        <Refusal text={refusal} />
      </div>
    </span>
  );
}
