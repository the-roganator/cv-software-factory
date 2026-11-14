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
import { attacksOffered } from './attacks-seam.ts';
import { Bird } from './components/Bird.tsx';
import { Canary } from './components/Canary.tsx';
import { Footer } from './components/Footer.tsx';
import { Header, LineStatus, Scoreboard } from './components/Header.tsx';
import { Later, NotLoaded } from './components/Later.tsx';
import { Line } from './components/Line.tsx';
import { LogoSymbols } from './components/Logos.tsx';
import { PreviewBanner } from './components/Preview.tsx';
import { Reel } from './components/Reel.tsx';
import { EmptyReel, States } from './components/States.tsx';
import { StepUpProvider } from './components/StepUp.tsx';
import { factoryOf } from './profile.ts';
import { foldOf, project, settingsAt } from './projection/index.ts';
import { useRefusalChecks } from './refusals.ts';
import { type Theme, ticks, useMotion, useTheme, useTime } from './settings.ts';
import { sheetCode } from './sheet-chunks.ts';
import { askedSheet, type SheetAsk } from './sheets.ts';
import { type Origin, origin, useEvents } from './source.ts';
import { useHeld } from './use-held.ts';
import { useSheet } from './use-sheet.ts';

const params = new URLSearchParams(location.search);

/** The doors' code, and the passkey ceremonies', arrive only on a door. */
const Doors = lazy(() => import('./components/Doors.tsx').then((module) => ({ default: module.Doors })));

/** The settings' code arrives only on their page. */
const Settings = lazy(() => import('./components/Settings.tsx').then((module) => ({ default: module.Settings })));

/** The audit log's code arrives only on its page. */
const AuditLog = lazy(() => import('./components/AuditLog.tsx').then((module) => ({ default: module.AuditLog })));

/*
 * Everything under the reel arrives once the first view has shown, each panel's module in a chunk of its own: the
 * bottom row, Needs you, and Controls, Flags, the summaries of Patching and Guardrails, and Spend beside it (Controls
 * and Spend from one module and so one chunk, which the settings page shares; the two summaries from another, with
 * Patching's projection). The first view is the header, the intro, the line, the canary and the reel, and its entry
 * chunk carries none of theirs. The bottom row draws once all of its chunks have come, so nothing in it moves as one
 * arrives (`Later`, which says so if a chunk never comes).
 */
const NeedsYou = lazy(() => import('./components/NeedsYou.tsx').then((module) => ({ default: module.NeedsYou })));
const Controls = lazy(() => import('./components/Controls.tsx').then((module) => ({ default: module.Controls })));
const FlagsPanel = lazy(() => import('./components/Flags.tsx').then((module) => ({ default: module.FlagsPanel })));
const SpendPanel = lazy(() => import('./components/Controls.tsx').then((module) => ({ default: module.SpendPanel })));
const PatchingSummary = lazy(() =>
  import('./components/Summaries.tsx').then((module) => ({ default: module.PatchingSummary })),
);
const GuardrailsSummary = lazy(() =>
  import('./components/Summaries.tsx').then((module) => ({ default: module.GuardrailsSummary })),
);

/** The privacy page's too. */
const Privacy = lazy(() => import('./components/Privacy.tsx').then((module) => ({ default: module.Privacy })));

const asked = params.get('view');
/** What a sheet is, in a notice that says it couldn't be shown. */
const SHEET_NAME: Record<SheetAsk['kind'], string> = {
  item: 'The work item’s sheet',
  patching: 'Patching’s sheet',
  guardrails: 'Guardrails’ sheet',
};
const door: Door | undefined = asked === 'sign-in' || asked === 'enrol' ? asked : undefined;
const settingsPage = asked === 'settings';
const auditPage = asked === 'audit';
const privacyPage = asked === 'privacy';
/** The sheet the address asks for: a work item's, or Patching's or Guardrails', at a row or at its top. */
const askedFor = askedSheet(params);
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
  // Whether the app holds the flags as set, under the flags: asked of the admin service, wherever there is one, for
  // everyone.
  const service = signedIn.kind === 'martin' || signedIn.kind === 'visitor';
  const held = useHeld(from.kind === 'live' && service && !settingsPage && !auditPage && !privacyPage);
  const latest = source.events.length ? Date.parse(source.events.at(-1)?.ts ?? '') : undefined;
  const t = useTime(latest, from.kind === 'live');
  // Whether each relayed refusal Guardrails shows is what the GitHub worker signed, as the server checks it.
  const checks = useRefusalChecks(source.events, from);
  const view = useMemo(() => project(source.events, t, attacksOffered, checks), [source.events, t, checks]);
  // Whether the canary bird is out of its cage, keeping the Canary panel company.
  const [birdOut, setBirdOut] = useState(false);
  const flying = view.canary.state === 'shown' && !view.canary.release.end ? view.canary.release : undefined;
  const settings = useMemo(() => settingsAt(foldOf(view).settings, factory.profile, t), [view, t]);
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
  // What the sheet holds, if it is open: a work item, or a panel whole, and the hand-over from one to the next.
  const { shown, failed, open: openSheet, close: closeSheet, dismiss } = useSheet();
  const setOpen = useCallback(
    (number: string | undefined) => openSheet(number ? { kind: 'item', item: number } : undefined),
    [openSheet],
  );
  // Each held steady, so a summary drawn with one renders only when what it shows changes.
  const openPatching = useCallback(() => openSheet({ kind: 'patching' }), [openSheet]);
  const openGuardrails = useCallback(() => openSheet({ kind: 'guardrails' }), [openSheet]);
  const openRow = useCallback((row: string) => openSheet({ kind: 'patching', row }), [openSheet]);
  const atNow = useRef(true);
  const resting = Math.max(0, Math.min(n - 1, centre ?? n - 1));

  useEffect(() => {
    if (!n || centre !== undefined) return;
    const index = view.cards.findIndex((card) => card.number === item);
    if (index >= 0) {
      atNow.current = index >= n - 1;
      setCentre(index);
      if (askedFor?.kind === 'item') setOpen(askedFor.item);
    }
  }, [n, centre, item, view.cards, setOpen]);

  // A panel's sheet the address asks for opens once the store has answered, so it opens on what it shows.
  const panelAsked = useRef(askedFor?.kind === 'patching' || askedFor?.kind === 'guardrails');
  useEffect(() => {
    if (!settled || !panelAsked.current) return;
    panelAsked.current = false;
    openSheet(askedFor);
  }, [settled, openSheet]);

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

  /** A sheet whose code is in: a work item's, or a panel's whole. */
  const drawSheet = (ask: SheetAsk, rise: boolean, onClose: () => void) => {
    if (ask.kind === 'item') {
      const Sheet = sheetCode('item');
      return (
        Sheet && (
          <Sheet
            view={view}
            item={ask.item}
            motion={motion}
            rise={rise}
            onStep={(index) => {
              onCentre(index);
              setOpen(view.cards[index]?.number);
            }}
            onClose={onClose}
            app={factory.app}
            admin={admin}
            onMoved={held.refresh}
          />
        )
      );
    }
    if (ask.kind === 'patching') {
      const PatchingSheet = sheetCode('patching');
      return (
        PatchingSheet && (
          <PatchingSheet
            view={view}
            admin={admin}
            row={ask.row}
            onOpen={setOpen}
            motion={motion}
            rise={rise}
            onClose={onClose}
          />
        )
      );
    }
    const GuardrailsSheet = sheetCode('guardrails');
    return (
      GuardrailsSheet && (
        <GuardrailsSheet
          view={view.guardrails}
          now={view.t}
          admin={admin}
          row={ask.row}
          onOpen={setOpen}
          motion={motion}
          rise={rise}
          onClose={onClose}
        />
      )
    );
  };

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
              lineStopped={!view.header.running}
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
          {/* Under the reel, once the store has answered and the first view has shown: the bottom row once its chunks
              have arrived, so nothing above it moves as it does; only the footer under it does. Until then nothing
              holds its place. */}
          {settled && (
            <Later what="Needs you, Controls, Flags, Patching, Guardrails and Spend">
              <section
                className="bottom"
                aria-label={
                  admin.kind === 'martin'
                    ? 'Needs you, controls, flags, patching, guardrails and spend'
                    : 'Waiting on Martin, controls, flags, patching, guardrails and spend'
                }
              >
                <NeedsYou
                  needs={view.needs}
                  flags={view.flags}
                  admin={admin}
                  app={factory.app}
                  now={view.t}
                  onOpen={setOpen}
                  onRow={openRow}
                  onMoved={held.refresh}
                />
                <div className="bottom-side">
                  <Controls
                    profile={factory.profile}
                    controls={view.controls}
                    admin={admin}
                    onGuardrails={openGuardrails}
                  />
                  <FlagsPanel
                    flags={view.flags}
                    admin={admin}
                    app={factory.app}
                    held={held.answer}
                    now={view.t}
                    onOpen={setOpen}
                    onMoved={held.refresh}
                  />
                  {/* Each a summary of its panel, opening it whole in a sheet: they arrive with the rest of the
                      bottom row, and only a failure of their own chunk is theirs. */}
                  <Later what="Patching and Guardrails" along>
                    <PatchingSummary view={view} martin={admin.kind === 'martin'} onSheet={openPatching} />
                    <GuardrailsSummary
                      view={view.guardrails}
                      now={view.t}
                      martin={admin.kind === 'martin'}
                      onSheet={openGuardrails}
                    />
                  </Later>
                  <SpendPanel spend={settings.spend} admin={admin} />
                </div>
              </section>
            </Later>
          )}
        </div>
      </main>
      <Footer signIn={signedIn.kind === 'visitor'} />
      {shown && (
        // Keyed by which sheet it is, so each is a frame of its own; one that throws as it draws says so over the page.
        <Later key={shown.n} what={SHEET_NAME[shown.ask.kind]} one onDismiss={closeSheet}>
          {drawSheet(shown.ask, shown.rise, closeSheet)}
        </Later>
      )}
      {/* A sheet whose code never came says so over the page, in its place, with Close; opening it again asks again. */}
      {failed && (
        <NotLoaded
          what={SHEET_NAME[failed.kind]}
          again="Close this and open it again to try again, or reload the page."
          onDismiss={dismiss}
        />
      )}
    </OriginContext.Provider>
  );
}
