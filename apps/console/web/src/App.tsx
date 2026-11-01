/**
 * The console: events in, the page out. Everything below is drawn from `project(events, t)`, of the full events for
 * Martin signed in and of the public ones for everyone else, Martin previewing as a visitor among them. The doors,
 * signing in and enrolling a passkey, are pages of their own on the same address (`?view=sign-in`, `?view=enrol`),
 * and so are the settings (`?view=settings`), the audit log (`?view=audit`) and the privacy page (`?view=privacy`),
 * under the console's own header. The audit log reads the public events for everyone, Martin included, so it is the
 * same log whoever reads it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Admin, type Door, stillSignedIn, useAdmin } from './admin.ts';
import { OriginContext } from './artifacts.ts';
import { Bird } from './components/Bird.tsx';
import { Canary } from './components/Canary.tsx';
import { Controls } from './components/Controls.tsx';
import { useHeld } from './components/Flags.tsx';
import { Footer } from './components/Footer.tsx';
import { Header, LineStatus, Scoreboard } from './components/Header.tsx';
import { Line } from './components/Line.tsx';
import { LogoSymbols } from './components/Logos.tsx';
import { NeedsYou } from './components/NeedsYou.tsx';
import { PreviewBanner } from './components/Preview.tsx';
import { Reel } from './components/Reel.tsx';
import { EmptyReel, States } from './components/States.tsx';
import { StepUpProvider } from './components/StepUp.tsx';
import { factoryOf } from './profile.ts';
import { project, projectSheet, settingsView } from './projection/index.ts';
import { type Theme, ticks, useMotion, useTheme, useTime } from './settings.ts';
import { type Origin, origin, useEvents } from './source.ts';

const params = new URLSearchParams(location.search);

/** The sheet's code arrives when the first sheet opens: the first view does not need it. */
const Sheet = lazy(() => import('./components/Sheet.tsx').then((module) => ({ default: module.Sheet })));

/** The doors' code, and the passkey ceremonies', arrive only on a door. */
const Doors = lazy(() => import('./components/Doors.tsx').then((module) => ({ default: module.Doors })));

/** The settings' code arrives only on their page. */
const Settings = lazy(() => import('./components/Settings.tsx').then((module) => ({ default: module.Settings })));

/** The audit log's code arrives only on its page. */
const AuditLog = lazy(() => import('./components/AuditLog.tsx').then((module) => ({ default: module.AuditLog })));

/** The privacy page's too. */
const Privacy = lazy(() => import('./components/Privacy.tsx').then((module) => ({ default: module.Privacy })));

const asked = params.get('view');
const door: Door | undefined = asked === 'sign-in' || asked === 'enrol' ? asked : undefined;
const settingsPage = asked === 'settings';
const auditPage = asked === 'audit';
const privacyPage = asked === 'privacy';
/** The profile whose policy bounds the settings, and whether every agent goes to the local model, as the server says. */
const factory = factoryOf();

export function App() {
  const from = useMemo(() => origin(), []);
  const [theme, setTheme] = useTheme();
  const [motion, setMotion] = useMotion();
  const admin = useAdmin(from.kind === 'live');

  // Signed in already, the sign-in door has nothing to do.
  useEffect(() => {
    if (door === 'sign-in' && admin.kind === 'martin') location.replace('/');
  }, [admin.kind]);

  if (door) {
    return (
      <>
        {/* The footer's icons are drawn from these, on the doors as on every page. */}
        <LogoSymbols />
        <Suspense fallback={null}>
          <Doors door={door} />
        </Suspense>
        <Footer signIn={false} />
      </>
    );
  }
  // Martin's writes ask for his passkey again where the access table says, through one dialog for the whole page.
  return (
    <StepUpProvider session={admin.kind === 'martin' ? admin.session : undefined}>
      <Console from={from} admin={admin} theme={theme} onTheme={setTheme} motion={motion} onMotion={setMotion} />
    </StepUpProvider>
  );
}

interface ConsoleProps {
  from: Origin;
  admin: Admin;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  motion: boolean;
  onMotion: (on: boolean) => void;
}

function Console({ from, admin: signedIn, theme, onTheme: setTheme, motion, onMotion: setMotion }: ConsoleProps) {
  // Martin, signed in, reads the full events, until he previews as a visitor or his session ends. A reload ends a
  // preview: it is a look, not a mode to come back to.
  const [previewing, setPreviewing] = useState(false);
  const [ended, setEnded] = useState(false);
  const martin = signedIn.kind === 'martin' && !ended;
  const expiresAt = signedIn.kind === 'martin' ? signedIn.session.expiresAt : undefined;
  // Who everything under the header is drawn for: Martin, until he previews as a visitor or his session ends, so
  // nothing of his shows in a preview. Only the header and the footer go by whether he is signed in.
  const admin: Admin = martin && !previewing ? signedIn : { kind: 'visitor' };
  const lost = useCallback(async () => {
    const live = expiresAt !== undefined && (await stillSignedIn(expiresAt));
    if (!live) setEnded(true);
    return live;
  }, [expiresAt]);
  const source = useEvents(from, admin.kind === 'martin' && !auditPage ? 'full' : 'public', lost);
  // Whether the app holds the flags as set, under Controls: asked of the admin service, wherever there is one, for
  // everyone.
  const service = signedIn.kind === 'martin' || signedIn.kind === 'visitor';
  const held = useHeld(from.kind === 'live' && service && !settingsPage && !auditPage && !privacyPage);
  const latest = source.events.length ? Date.parse(source.events.at(-1)?.ts ?? '') : undefined;
  const t = useTime(latest, from.kind === 'live');
  const view = useMemo(() => project(source.events, t), [source.events, t]);
  // Whether the canary bird is out of its cage, keeping the Canary panel company.
  const [birdOut, setBirdOut] = useState(false);
  const flying = view.canary.state === 'shown' && !view.canary.release.end ? view.canary.release : undefined;
  const settings = useMemo(() => settingsView(source.events, factory.profile, t), [source.events, t]);
  const n = view.cards.length;
  // The reel draws just after the line, not with it: it is most of the page's work, and the line is what a visitor
  // reads first. An effect runs after the frame that drew the line, so the reel comes in the next.
  const [reel, setReel] = useState(false);
  useEffect(() => setReel(n > 0), [n]);
  // The store has answered at least once: an empty one is empty, not loading.
  const settled = source.connection === 'live' || source.connection === 'recorded' || source.events.length > 0;

  // The reel rests on the latest work item unless the viewer moves it, or asked for one in the address.
  const item = params.get('item');
  const [centre, setCentre] = useState<number | undefined>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const atNow = useRef(true);
  const resting = Math.max(0, Math.min(n - 1, centre ?? n - 1));

  useEffect(() => {
    if (!n || centre !== undefined) return;
    const index = view.cards.findIndex((card) => card.number === item);
    if (index >= 0) {
      atNow.current = index >= n - 1;
      setCentre(index);
      if (params.has('sheet')) setOpen(item ?? undefined);
    }
  }, [n, centre, item, view.cards]);

  // Following the line: a viewer watching now stays at now as new work items arrive.
  useEffect(() => {
    if (atNow.current && centre !== undefined && n) setCentre(n - 1);
  }, [n, centre]);

  const onCentre = useCallback(
    (index: number) => {
      atNow.current = index >= n - 1;
      setCentre(index);
    },
    [n],
  );
  // The first meaningful view: the line drawn from the factory's events. The speed test waits for this mark.
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !n) return;
    marked.current = true;
    performance.mark('sf:first-view');
  }, [n]);

  const preview = (on: boolean) => {
    setPreviewing(on);
    setOpen(undefined);
    window.scrollTo(0, 0);
    // Back to admin takes its button away: focus goes to the account button, whose menu has Preview as visitor.
    if (!on) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.account-btn')?.focus());
  };

  const sheet = useMemo(() => (open ? projectSheet(view, open) : undefined), [open, view]);
  const sheetIndex = sheet ? view.cards.findIndex((card) => card.number === sheet.card.number) : -1;

  if (settingsPage || auditPage || privacyPage) {
    return (
      <OriginContext.Provider value={from}>
        <LogoSymbols />
        {martin && previewing && <PreviewBanner onBack={() => preview(false)} />}
        <Header
          line={view.header}
          connection={source.connection}
          theme={theme}
          onTheme={setTheme}
          motion={motion}
          onMotion={setMotion}
          admin={martin ? signedIn : { kind: 'visitor' }}
          previewing={previewing}
          onPreview={() => preview(true)}
          away
        />
        <main id="top">
          <div className="wrap">
            <Suspense fallback={null}>
              {privacyPage ? (
                <Privacy />
              ) : auditPage ? (
                <AuditLog events={source.events} t={t} profile={factory.profile} settled={settled} />
              ) : (
                <Settings view={settings} controls={view.controls} allLocal={factory.allLocal} admin={admin} />
              )}
            </Suspense>
          </div>
        </main>
        <Footer signIn={signedIn.kind === 'visitor'} />
      </OriginContext.Provider>
    );
  }

  return (
    <OriginContext.Provider value={from}>
      <LogoSymbols />
      {martin && previewing && <PreviewBanner onBack={() => preview(false)} />}
      <Header
        line={view.header}
        connection={source.connection}
        theme={theme}
        onTheme={setTheme}
        motion={motion}
        onMotion={setMotion}
        admin={martin ? signedIn : { kind: 'visitor' }}
        previewing={previewing}
        onPreview={() => preview(true)}
      />
      <main id="top">
        <div className="wrap">
          <section className="intro" aria-labelledby="app-name">
            <div>
              <h1 id="app-name">The World’s Worst Website</h1>
              <p className="sub">a deliberately broken app, looked after by agents</p>
            </div>
            <span className="status phone-status">
              <LineStatus line={view.header} connection={source.connection} />
            </span>
            <Scoreboard score={view.score} sample={view.sample} />
          </section>
          <States source={source} view={view} />
          {/* What the page holds once the store has answered is history; the bird reacts to what arrives after. */}
          {settled && (
            <Bird
              events={source.events}
              live={ticks(from.kind === 'live')}
              release={flying}
              motion={motion}
              onOut={setBirdOut}
            />
          )}
          {/* The stations draw at once, idle, and take their states as the events arrive. */}
          <Line
            view={view}
            motion={motion}
            onOpen={setOpen}
            admin={admin}
            pending={!source.events.length && !settled}
            birdOut={birdOut}
          />
          {settled && (
            <Canary
              view={view.canary}
              t={view.t}
              onOpen={setOpen}
              admin={admin}
              lineStopped={view.header.stopped !== undefined}
              ticking={ticks(from.kind === 'live')}
              motion={motion}
              autoRollback={view.controls.autoRollback}
            />
          )}
          {/* An empty store waits for the server to say what kind it is, so it is described once, rightly. */}
          {n === 0 && settled && (source.store !== undefined || source.connection !== 'live') && (
            <EmptyReel store={source.store} />
          )}
          {n > 0 && reel && (
            <Reel
              view={view}
              centre={resting}
              onCentre={onCentre}
              onOpen={(index) => setOpen(view.cards[index]?.number)}
              motion={motion}
            />
          )}
          {settled && (
            <section
              className="bottom"
              aria-label={admin.kind === 'martin' ? 'Needs you and controls' : 'Waiting on Martin, and controls'}
            >
              <NeedsYou
                needs={view.needs}
                flags={view.flags}
                admin={admin}
                app={factory.app}
                onOpen={setOpen}
                onMoved={held.refresh}
              />
              <Controls
                profile={factory.profile}
                spend={settings.spend}
                controls={view.controls}
                flags={view.flags}
                admin={admin}
                app={factory.app}
                held={held.answer}
                now={view.t}
                onOpen={setOpen}
                onMoved={held.refresh}
              />
            </section>
          )}
        </div>
      </main>
      <Footer signIn={signedIn.kind === 'visitor'} />
      {sheet && (
        <Suspense fallback={null}>
          <Sheet
            sheet={sheet}
            index={sheetIndex}
            count={n}
            motion={motion}
            onStep={(index) => {
              onCentre(index);
              setOpen(view.cards[index]?.number);
            }}
            onClose={() => setOpen(undefined)}
            app={factory.app}
            admin={admin}
            onMoved={held.refresh}
          />
        </Suspense>
      )}
    </OriginContext.Provider>
  );
}
