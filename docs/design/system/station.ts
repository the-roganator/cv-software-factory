/**
 * <sf-station>: one stage of the factory line, drawn as a small machine on a length of belt.
 *
 *   <sf-station kind="build" status="working"></sf-station>
 *
 * The tool on top says what the stage does (kind). The face, beacon, hatch and belt say how
 * it is doing (status). Eight stations side by side make one continuous 1344px conveyor.
 *
 * Attributes
 *   kind     sense | triage | plan | build | gates | review | release | verify   (default build)
 *   status   idle | working | returning | passing | blocked | failed            (default idle)
 *   beacon   needs-you | failed: a person should look while the machine works on. The beacon flashes,
 *            and for a failure the machine rattles and sparks; the tool, face, hatch and belt still say
 *            what it is doing. Only working and returning show it: blocked and failed light their own.
 *   motion   "off" draws the still pose. Motion also stops under prefers-reduced-motion.
 *   bird     "out" empties the Release station's cage: the console draws its bird elsewhere while a
 *            release is in flight, and the cage keeps its bars, its perch and its note.
 *   label    Accessible name; defaults to "<Stage>: <state>".
 *   decorative  Present when something else (a button, a caption) already names the station.
 *
 * Hover: lift the machine, never the belt, so the line stays continuous:
 *   button:hover sf-station::part(machine) { transform: translateY(-3px); }
 * The legs are tucked 4px under the body, so a lift of up to 4px reads as stretching.
 *
 * Colour comes from the design system's CSS custom properties (tokens.css, or properties.css in the console), which
 * inherit into the shadow tree, so the station follows the Paper or Ink theme of its container.
 *
 * This TypeScript module is the source, and the console imports it as it is. Its styles are one
 * constructed stylesheet shared by every station, and its drawing uses classes and presentation
 * attributes, never a <style> element or a style attribute, so it runs under a content security
 * policy that allows neither. build.ts writes station.js from it: the same element as a classic
 * script, for design pages opened from disk, exposing globalThis.SFStation.
 */

export const KINDS = ['sense', 'triage', 'plan', 'build', 'gates', 'review', 'release', 'verify'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['idle', 'working', 'returning', 'passing', 'blocked', 'failed'] as const;
export type Status = (typeof STATUSES)[number];
export const BEACONS = ['needs-you', 'failed'] as const;
export type Beacon = (typeof BEACONS)[number];

export const STAGE_NAME: Record<Kind, string> = {
  sense: 'Sense', triage: 'Triage', plan: 'Plan', build: 'Build',
  gates: 'Gates', review: 'Review', release: 'Release', verify: 'Verify',
};

/** Short state words for captions. Tone says which colour role goes with them. */
export const STATE: Record<Status, { label: string; tone: 'faint' | 'signal' | 'ok' | 'attn' }> = {
  idle: { label: 'idle', tone: 'faint' },
  working: { label: 'working', tone: 'signal' },
  returning: { label: 'sending back', tone: 'signal' },
  passing: { label: 'passed', tone: 'ok' },
  blocked: { label: 'needs you', tone: 'attn' },
  failed: { label: 'failed', tone: 'attn' },
};

/* ---- Motion worked out from the drawing ---------------------------------------------- */

const f2 = (n: number) => n.toFixed(2);

/** One keyframe rule from [percent, transform] pairs. */
function keyframes(name: string, frames: [number, string][]): string {
  return `@keyframes ${name} { ${frames.map(([at, t]) => `${f2(at)}% { transform: ${t}; }`).join(' ')} }`;
}

/*
 * Plan's compass turns once about its needle point, on the roof's front edge, and the nib traces an ellipse centred there,
 * so the near half of the circle crosses the machine's face. Each leg is a stroke of its rest length placed by translate,
 * rotate and scaleY along its length, so its width never changes as it foreshortens; the hinge rides on top. The turn
 * takes 16 steps over the first 75% of the cycle, at equal lengths round the ellipse, so the nib keeps to the end of the
 * circle as stroke-dashoffset draws it; the compass rests while the circle fades.
 */
const NEEDLE = { x: 66, y: 44 };
const HINGE = { dx: 9, dy: -34 }; // from the needle point, at rest
const CIRCLE = { rx: 18, ry: 5 };
const LEG = Math.hypot(HINGE.dx, HINGE.dy); // both legs' rest length: the nib's foot is as far from the hinge as the needle's
const TURN = 75;
const COMPASS_STEPS = 16;

/** Points at equal lengths along a curve, from a dense sampling of it. */
function evenly(points: [number, number][], steps: number): [number, number][] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1] as [number, number];
    const [bx, by] = points[i] as [number, number];
    lengths.push((lengths[i - 1] as number) + Math.hypot(bx - ax, by - ay));
  }
  const total = lengths[lengths.length - 1] as number;
  return Array.from({ length: steps + 1 }, (_, k) => {
    const i = lengths.findIndex((l) => l >= (total * k) / steps - 1e-9);
    return points[i] as [number, number];
  });
}

/** A leg from its foot (ax, ay) to the hinge (bx, by), as a transform of the upright stroke it is drawn as. */
function leg(ax: number, ay: number, bx: number, by: number, rest: number): string {
  const dx = bx - ax;
  const dy = by - ay;
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return `translate(${f2(ax)}px, ${f2(ay)}px) rotate(${f2(angle)}deg) scaleY(${(Math.hypot(dx, dy) / rest).toFixed(3)})`;
}

function compassAt(turn: number): { needle: string; nib: string; hinge: string } {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const hx = NEEDLE.x + HINGE.dx * c;
  const hy = NEEDLE.y + HINGE.dy + HINGE.dx * (CIRCLE.ry / CIRCLE.rx) * s;
  const px = NEEDLE.x + CIRCLE.rx * c;
  const py = NEEDLE.y + CIRCLE.ry * s;
  return {
    needle: leg(NEEDLE.x, NEEDLE.y, hx, hy, LEG),
    nib: leg(px, py, hx, hy, LEG),
    hinge: `translate(${f2(hx)}px, ${f2(hy)}px)`,
  };
}

const COMPASS_REST = compassAt(0);
// The angle round the ellipse at each step, from points at equal lengths along it (a point's angle as the nib's).
const COMPASS_TURNS = evenly(
  Array.from({ length: 721 }, (_, i): [number, number] => {
    const t = (2 * Math.PI * i) / 720;
    return [CIRCLE.rx * Math.cos(t), CIRCLE.ry * Math.sin(t)];
  }),
  COMPASS_STEPS,
).map(([x, y], n) => (n === COMPASS_STEPS ? 2 * Math.PI : (Math.atan2(y / CIRCLE.ry, x / CIRCLE.rx) + 2 * Math.PI) % (2 * Math.PI)));
const COMPASS_POSES = COMPASS_TURNS.map((turn, n) => [(TURN * n) / COMPASS_STEPS, compassAt(turn)] as const);
const COMPASS_KEYFRAMES = (['needle', 'nib', 'hinge'] as const)
  .map((part) => keyframes(part, [
    ...COMPASS_POSES.map(([at, pose]): [number, string] => [at, pose[part]]),
    [100, COMPASS_REST[part]],
  ]))
  .join('\n');

/*
 * Verify's pen signs MR in one stroke, as in the mark: the M's last downstroke is the R's stem. The signature is drawn by
 * stroke-dashoffset, which runs at an even pace along its length, so the pen's keyframes are points at equal lengths along
 * the same curve, and the nib stays on the ink. The pen stands in the inkwell, dips, signs from 14% of the cycle to 60%,
 * lifts aside while the signature holds, and goes back to the inkwell.
 */
const SIG = 'M0 16 C1 10 2.5 4 3.5 0.5 C5 4 7 8 8.5 10.5 C10 7 11.5 3 13 0.5 C13 6 13 11 13 16 '
  + 'C13 11 13 5 13 0.5 C20 -0.5 23 1.5 23 4 C23 7 18 8.5 13.5 8 C17 10 20 13.5 22.5 16 C26 19 32 17 36 12';
const SIGNED = 60;
const INKED = 14;
const PEN_INKWELL = 'translate(17px, 21px)';
const PEN_DIPPED = 'translate(17px, 24px)';
const PEN_ASIDE = 'translate(44px, -2px)';

/** Points at equal lengths along the signature, which is one M and absolute C segments, as written. */
function alongSignature(steps: number): [number, number][] {
  const n = (SIG.match(/-?[\d.]+/g) ?? []).map(Number);
  const points: [number, number][] = [];
  let x = n[0] ?? 0;
  let y = n[1] ?? 0;
  for (let i = 2; i + 5 < n.length; i += 6) {
    const [x1, y1, x2, y2, x3, y3] = n.slice(i, i + 6) as [number, number, number, number, number, number];
    for (let j = 0; j < 200; j++) {
      const t = j / 200;
      const u = 1 - t;
      points.push([
        u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      ]);
    }
    x = x3;
    y = y3;
  }
  points.push([x, y]);
  return evenly(points, steps);
}

const PEN_STEP_COUNT = 36;
const PEN_STEPS = alongSignature(PEN_STEP_COUNT);
const SIGN_KEYFRAMES = keyframes('sign', [
  [0, PEN_INKWELL], [5, PEN_DIPPED], [10, PEN_INKWELL],
  ...PEN_STEPS.map(([x, y], k): [number, string] => [INKED + ((SIGNED - INKED) * k) / PEN_STEP_COUNT, `translate(${f2(x)}px, ${f2(y)}px)`]),
  [68, PEN_ASIDE], [88, PEN_ASIDE], [96, PEN_INKWELL], [100, PEN_INKWELL],
]);

const CSS = `
:host {
  display: inline-block; position: relative; vertical-align: top;
  width: 168px; aspect-ratio: 168 / 220; height: auto;
  --_ink: var(--text, #202020);
  --_paper: var(--raised, #fbfaf7);
  --_steel: var(--surface, #ebe6dd);
  --_face: var(--station-face, #252321);
  --_faint: var(--text-faint, #a8a095);
  --_canary: var(--station-canary, #e9c46a);
}
svg { display: block; width: 100%; height: 100%; overflow: visible; }
.machine { transition: transform .2s var(--motion-ease, ease); }
.s-idle      { --tone: var(--text-faint, #a8a095); --led: var(--station-led-dim, #77716a); }
.s-working,
.s-returning { --tone: var(--signal, #2a2826); --led: var(--station-led-on, #f4f1ea); }
.s-passing   { --tone: var(--ok, #3b6631); --led: var(--station-led-ok, #a9c79c); }
.s-blocked,
.s-failed    { --tone: var(--attn, #b53c0a); --led: var(--station-led-attn, #f09a64); }
/* A beacon on a working machine: only the beacon takes the attention colour. */
.b-needs-you,
.b-failed    { --beacon: var(--attn, #b53c0a); }

/* Linework */
.part  { fill: var(--_paper); stroke: var(--_ink); stroke-width: 1.75; stroke-linejoin: round; }
.steel { fill: var(--_steel); stroke: var(--_ink); stroke-width: 1.75; }
.body  { fill: var(--_paper); stroke: var(--_ink); stroke-width: 2; }
.ink   { fill: var(--_ink); }
.line  { fill: none; stroke: var(--_ink); stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.thin  { fill: none; stroke: var(--_ink); stroke-width: 1.25; stroke-linecap: round; }
.face  { fill: var(--_face); }
.led   { fill: none; stroke: var(--led); stroke-linecap: round; stroke-linejoin: round; }
.led-fill { fill: var(--led); }
.tone  { fill: none; stroke: var(--tone); stroke-linecap: round; stroke-linejoin: round; }
.tone-fill { fill: var(--tone); }
.faint { fill: none; stroke: var(--_faint); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.parcel { fill: var(--_steel); stroke: var(--_ink); stroke-width: 1.5; }
.bird  { fill: var(--_canary); stroke: var(--_ink); stroke-width: 1.5; stroke-linejoin: round; }
.beacon-glow { fill: var(--beacon, var(--tone)); opacity: 0; }
.ray   { fill: none; stroke: var(--beacon, var(--tone)); stroke-linecap: round; }
.s-passing .beacon-glow { opacity: .18; }
.s-blocked .beacon-glow, .s-failed .beacon-glow, .b-needs-you .beacon-glow, .b-failed .beacon-glow { opacity: .3; }
.roller { fill: var(--_steel); stroke: var(--_ink); stroke-width: 1.5; }
.chev  { fill: none; stroke: var(--_ink); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: .55; }
.s-idle .chev { opacity: .22; }
.s-blocked .chev, .s-failed .chev { opacity: .35; }
.hazard-stripe { fill: var(--_face); }
.fault { fill: var(--led); font: 500 12px/1 'Geist Mono', ui-monospace, Menlo, monospace; letter-spacing: 2.5px; }
.zz { fill: none; stroke: var(--_faint); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

/* What were inline styles: the console's content security policy refuses style attributes. */
.rim   { stroke: var(--_ink); }
.glare { stroke: var(--_paper); stroke-width: 2; }
.track { fill: var(--_ink); opacity: .14; }
.frame { fill: none; stroke: var(--_ink); stroke-width: 1.75; }
.belt  { fill: var(--_steel); }
.seam  { stroke: var(--_steel); stroke-width: 2.5; stroke-linecap: round; }
.dome  { fill: var(--beacon, var(--tone)); stroke: var(--_ink); stroke-width: 1.75; stroke-linejoin: round; }
.puff  { fill: var(--_faint); }
.spark { fill: none; stroke: var(--attn, #b53c0a); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.spark-core { fill: var(--attn, #b53c0a); }
.sparks { transform-origin: 24px 103px; }
.rattle { transform-origin: 84px 150px; }
.puff-a { transform-origin: 44px 40px; }
.puff-b { transform-origin: 51px 40px; }

/* The bird out of its cage: the cage stays as it is, empty. */
:host([bird="out"]) .bird-ok, :host([bird="out"]) .bird-down { visibility: hidden; }

/* Pivots, in the SVG's user units */
.pivot, .paper, .sense-dish, .needle, .nib, .hinge, .pen, .build-arm, .gate-boom, .lens, .bird-ok, .belt-run,
.eyes, .bar, .sift, .reject, .pass, .puff, .sparks, .rattle, .note, .wave, .glint, .alarm, .zz path {
  transform-box: view-box;
}
.sense-dish { transform-origin: 74px 31px; }
/* Triage's funnel is drawn at 85%: its strokes are thickened to match, so they keep the line's weight. */
.funnel .part   { stroke-width: 2.06; }
.funnel .parcel { stroke-width: 1.76; }
.reject     { transform-origin: 65px 11px; }
.needle     { transform: ${COMPASS_REST.needle}; }
.nib        { transform: ${COMPASS_REST.nib}; }
.hinge      { transform: ${COMPASS_REST.hinge}; }
.lens       { transform-origin: 56px 10px; }
.glass      { fill: var(--_steel); fill-opacity: .5; stroke: var(--_ink); stroke-width: 2.25; }
.tick       { opacity: 0; }
/* Review's page and Verify's card are put away behind the chassis at idle, and up whenever the stage has work. With no
   page under it, the lens rests just above the roof and shows a flare, not a line. */
.s-idle .paper { transform: translateY(46px); }
.s-idle .lens { transform: translate(14px, 13px); }
.flare      { opacity: 0; }
.s-idle .zoom { opacity: 0; }
.s-idle .flare { opacity: 1; }
.s-passing .tick { opacity: 1; }
/* Only a passed Verify shows a finished signature; at work, the pen writes it. */
.sig        { opacity: 0; }
.s-passing .sig { opacity: 1; }
.pen        { transform: ${PEN_INKWELL}; }
.s-passing .pen { transform: ${PEN_ASIDE}; }
.build-arm  { transform-origin: 74px 38px; transform: rotate(-18deg); }
.gate-boom  { transform-origin: 59px 16.5px; }
.s-passing .gate-boom { transform: rotate(-55deg); }
.bar        { transform-origin: 48px 129px; transform: scaleX(.62); }
.eyes       { transform-origin: 84px 82px; }

@media (prefers-reduced-motion: no-preference) {
  :host(:not([motion="off"])) .belt-run { animation: belt var(--_belt-dur, .7s) linear infinite; }
  :host(:not([motion="off"])) .s-passing  { --_belt-dur: 1.4s; }
  :host(:not([motion="off"])) .s-returning .belt-run { animation-name: belt-back; }
  :host(:not([motion="off"])) .s-idle .belt-run,
  :host(:not([motion="off"])) .s-blocked .belt-run,
  :host(:not([motion="off"])) .s-failed .belt-run { animation: none; }

  :host(:not([motion="off"])) .s-blocked .beacon-glow,
  :host(:not([motion="off"])) .s-failed .beacon-glow,
  :host(:not([motion="off"])) .b-needs-you .beacon-glow,
  :host(:not([motion="off"])) .b-failed .beacon-glow { animation: alarm-glow .9s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-blocked .dome,
  :host(:not([motion="off"])) .s-failed .dome,
  :host(:not([motion="off"])) .b-needs-you .dome,
  :host(:not([motion="off"])) .b-failed .dome,
  :host(:not([motion="off"])) .alarm { animation: flash .9s ease-in-out infinite; }

  :host(:not([motion="off"])) .s-working .eyes,
  :host(:not([motion="off"])) .s-returning .eyes { animation: blink 3.6s linear infinite; }
  :host(:not([motion="off"])) .s-working .bar { animation: fill 2.4s var(--motion-ease, ease-in-out) infinite; }
  :host(:not([motion="off"])) .glint { animation: twinkle 1.8s ease-in-out infinite; }
  :host(:not([motion="off"])) .zz path { animation: drift 2.8s ease-out infinite; }
  :host(:not([motion="off"])) .zz path + path { animation-delay: 1.4s; }
  :host(:not([motion="off"])) .puff { animation: puff 2.4s ease-out infinite; }
  :host(:not([motion="off"])) .puff + .puff { animation-delay: 1.2s; }
  :host(:not([motion="off"])) .sparks { animation: sparks 1.9s steps(1, end) infinite; }
  :host(:not([motion="off"])) .rattle { animation: rattle 2.6s linear infinite; }

  :host(:not([motion="off"])) .s-working .sense-dish,
  :host(:not([motion="off"])) .s-returning .sense-dish { animation: sweep 2.4s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .wave,
  :host(:not([motion="off"])) .s-returning .wave { animation: pulse-op 1.6s ease-in-out infinite; }
  :host(:not([motion="off"])) .wave + .wave { animation-delay: .4s; }
  :host(:not([motion="off"])) .s-working .sift,
  :host(:not([motion="off"])) .s-returning .sift { animation: sift 2.8s linear infinite; }
  :host(:not([motion="off"])) .s-working .reject,
  :host(:not([motion="off"])) .s-returning .reject { animation: reject 2.8s linear infinite; }
  :host(:not([motion="off"])) .s-working .pass,
  :host(:not([motion="off"])) .s-returning .pass { animation: pass 2.8s linear infinite; }
  :host(:not([motion="off"])) .s-working .needle,
  :host(:not([motion="off"])) .s-returning .needle { animation: needle 3.2s linear infinite; }
  :host(:not([motion="off"])) .s-working .nib,
  :host(:not([motion="off"])) .s-returning .nib { animation: nib 3.2s linear infinite; }
  :host(:not([motion="off"])) .s-working .hinge,
  :host(:not([motion="off"])) .s-returning .hinge { animation: hinge 3.2s linear infinite; }
  :host(:not([motion="off"])) .s-working .arc,
  :host(:not([motion="off"])) .s-returning .arc { animation: trace 3.2s linear infinite; }
  :host(:not([motion="off"])) .s-working .build-arm,
  :host(:not([motion="off"])) .s-returning .build-arm { animation: hammer .7s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .gate-boom,
  :host(:not([motion="off"])) .s-returning .gate-boom { animation: wobble 1.2s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .lens,
  :host(:not([motion="off"])) .s-returning .lens { animation: read 4.8s ease-in-out .9s infinite; }
  :host(:not([motion="off"])) .s-working .paper,
  :host(:not([motion="off"])) .s-returning .paper { animation: feed .9s both; }
  :host(:not([motion="off"])) .s-working .tick,
  :host(:not([motion="off"])) .s-returning .tick { animation: tick-1 4.8s linear .9s infinite; }
  :host(:not([motion="off"])) .s-working .tick + .tick,
  :host(:not([motion="off"])) .s-returning .tick + .tick { animation-name: tick-2; }
  :host(:not([motion="off"])) .s-working .tick + .tick + .tick,
  :host(:not([motion="off"])) .s-returning .tick + .tick + .tick { animation-name: tick-3; }
  :host(:not([motion="off"])) .s-working .bird-ok,
  :host(:not([motion="off"])) .s-returning .bird-ok { animation: bob .6s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-passing .bird-ok { animation: bob 1.2s ease-in-out infinite; }
  :host(:not([motion="off"])) .note { animation: pulse-op 1.6s ease-in-out infinite; }
  :host(:not([motion="off"])) .s-working .pen,
  :host(:not([motion="off"])) .s-returning .pen { animation: sign 3.6s linear .9s infinite; }
  :host(:not([motion="off"])) .s-working .sig,
  :host(:not([motion="off"])) .s-returning .sig { animation: ink 3.6s linear .9s infinite; }
}
@keyframes belt      { to { transform: translateX(21px); } }
@keyframes belt-back { to { transform: translateX(-21px); } }
@keyframes alarm-glow{ 0%, 100% { opacity: .45; } 50% { opacity: 0; } }
@keyframes flash     { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes blink     { 0%, 92%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.12); } }
@keyframes fill      { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes twinkle   { 0%, 100% { opacity: .15; } 50% { opacity: 1; } }
@keyframes drift     { from { transform: translate(0, 0); opacity: 0; } 30% { opacity: 1; } to { transform: translate(6px, -16px); opacity: 0; } }
@keyframes puff      { from { transform: translateY(0) scale(1); opacity: .7; } to { transform: translateY(-36px) scale(2.4); opacity: 0; } }
@keyframes sweep     { 0%, 100% { transform: rotate(-14deg); } 50% { transform: rotate(14deg); } }
@keyframes pulse-op  { 0%, 100% { opacity: .15; } 50% { opacity: 1; } }
/* Triage: a big parcel lands, then a small one; a shake, and the big one is tossed out while the small one goes down. */
@keyframes reject    { 0% { transform: translateY(-30px); opacity: 0; animation-timing-function: ease-in; } 6% { opacity: 1; }
  20% { transform: translateY(0); animation-timing-function: ease-out; } 25% { transform: translateY(-3px); animation-timing-function: ease-in; }
  30%, 62% { transform: translateY(0); opacity: 1; animation-timing-function: ease-out; }
  72% { transform: translate(-14px, -14px) rotate(-40deg); opacity: 1; animation-timing-function: ease-in; }
  86%, 100% { transform: translate(-28px, 10px) rotate(-90deg); opacity: 0; } }
@keyframes pass      { 0%, 26% { transform: translateY(-34px); opacity: 0; animation-timing-function: ease-in; } 30% { opacity: 1; }
  42% { transform: translateY(0); animation-timing-function: ease-out; } 46% { transform: translateY(-2px); animation-timing-function: ease-in; }
  50%, 66% { transform: translateY(0); opacity: 1; animation-timing-function: ease-in-out; }
  72% { transform: translate(-4.5px, 4px); animation-timing-function: ease-in; } 90%, 100% { transform: translate(-4.5px, 28px); opacity: 1; } }
@keyframes sift      { 0%, 52%, 67%, 100% { transform: translateX(0); } 55% { transform: translateX(-2px); }
  58% { transform: translateX(2px); } 61% { transform: translateX(-2px); } 64% { transform: translateX(1.5px); } }
/* Plan: the compass's turn, worked out above, and its circle drawn as the nib goes round, then faded. */
${COMPASS_KEYFRAMES}
@keyframes trace     { 0% { stroke-dashoffset: 100; opacity: 1; } 75% { stroke-dashoffset: 0; } 88% { opacity: 1; } 100% { stroke-dashoffset: 0; opacity: 0; } }
/* Review: the lens reads a line, leans in at its end, and a tick goes in the margin; three lines, then back to the top. */
@keyframes read      { 0% { transform: translate(0, 0); } 14% { transform: translate(18px, 0) scale(1); } 19% { transform: translate(18px, 0) scale(1.18); }
  25% { transform: translate(18px, 0) scale(1); } 32% { transform: translate(0, 8px); } 46% { transform: translate(18px, 8px) scale(1); }
  51% { transform: translate(18px, 8px) scale(1.18); } 57% { transform: translate(18px, 8px) scale(1); } 64% { transform: translate(0, 16px); }
  78% { transform: translate(18px, 16px) scale(1); } 83% { transform: translate(18px, 16px) scale(1.18); } 89% { transform: translate(18px, 16px) scale(1); }
  100% { transform: translate(0, 0); } }
/* Review's page and Verify's card come up from behind the roof in four clicks, like a typewriter's line feed. */
@keyframes feed      { 0% { transform: translateY(46px); animation-timing-function: ease-out; } 25% { transform: translateY(34px); animation-timing-function: ease-out; }
  50% { transform: translateY(22px); animation-timing-function: ease-out; } 75% { transform: translateY(10px); animation-timing-function: ease-out; } 100% { transform: translateY(0); } }
@keyframes tick-1    { 0%, 21% { opacity: 0; } 23%, 94% { opacity: 1; } 100% { opacity: 0; } }
@keyframes tick-2    { 0%, 53% { opacity: 0; } 55%, 94% { opacity: 1; } 100% { opacity: 0; } }
@keyframes tick-3    { 0%, 85% { opacity: 0; } 87%, 94% { opacity: 1; } 100% { opacity: 0; } }
@keyframes hammer    { 0%, 100% { transform: rotate(-32deg); } 55% { transform: rotate(14deg); } }
@keyframes wobble    { 0%, 100% { transform: rotate(-12deg); } 50% { transform: rotate(-3deg); } }
@keyframes bob       { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes sparks    { 0% { opacity: 1; transform: scale(1); } 6% { opacity: .2; transform: scale(1.25); } 10% { opacity: 1; transform: scale(.9); } 16%, 100% { opacity: 0; } }
@keyframes rattle    { 0%, 64%, 100% { transform: translate(0, 0) rotate(0); }
  67% { transform: translate(-1.5px, -.5px) rotate(-1.4deg); } 70% { transform: translate(1.5px, 0) rotate(1.2deg); }
  73% { transform: translate(-1px, -.8px) rotate(-1deg); } 76% { transform: translate(1.2px, 0) rotate(.9deg); }
  79% { transform: translate(-.6px, -.3px) rotate(-.5deg); } 82% { transform: translate(0, 0) rotate(0); } }
/* Verify: the pen dips, signs along the signature, worked out above, lifts aside, and the signature fades for the next. */
${SIGN_KEYFRAMES}
@keyframes ink       { 0%, ${INKED}% { stroke-dashoffset: 100; opacity: 1; } ${SIGNED}% { stroke-dashoffset: 0; } 88% { opacity: 1; } 100% { stroke-dashoffset: 0; opacity: 0; } }
`;

/* ---- Tools: what the stage does ------------------------------------------------------ */

const TOOLS: Record<Kind, (status: Status) => string> = {
  sense: () => `
    <rect class="ink" x="71" y="30" width="6" height="14"/>
    <g class="sense-dish">
      <path class="part" d="M56 18 Q74 44 92 18 Z"/>
      <path class="line" d="M74 30 V13"/>
      <circle class="tone-fill rim" cx="74" cy="10" r="3.5" stroke-width="1.5"/>
    </g>
    <g class="waves-set">
      <path class="tone wave" stroke-width="2" d="M98 12 q6 6 0 12"/>
      <path class="tone wave" stroke-width="2" d="M104 6 q10 12 0 24"/>
    </g>`,

  // At rest, both parcels sit in the funnel.
  triage: () => `
    <g class="funnel" transform="translate(74 44) scale(.85) translate(-74 -44)">
      <g class="sift">
        <path class="part" d="M50 10 H98 L80 30 V44 H68 V30 Z"/>
        <rect class="parcel reject" x="59" y="5" width="12" height="12" rx="1.5"/>
        <rect class="parcel pass" x="75" y="18" width="7" height="7" rx="1"/>
      </g>
    </g>`,

  // The compass is drawn over the chassis (FRONT, below).
  plan: () => '',

  build: () => `
    <rect class="ink" x="64" y="36" width="20" height="8" rx="1.5"/>
    <g class="build-arm">
      <path class="line" stroke-width="3.5" d="M74 38 V14"/>
      <rect class="part" x="60" y="4" width="28" height="12" rx="2.5"/>
      <rect class="tone-fill rim" x="80" y="4" width="8" height="12" rx="2" stroke-width="1.75"/>
    </g>`,

  gates: () => `
    <rect class="part" x="52" y="14" width="14" height="30" rx="1.5"/>
    <g class="gate-boom">
      <rect class="part" x="56" y="12" width="46" height="9" rx="4.5"/>
      <rect class="ink" x="68" y="13.5" width="6" height="6"/>
      <rect class="ink" x="80" y="13.5" width="6" height="6"/>
      <circle class="tone-fill" cx="97" cy="16.5" r="2.4"/>
    </g>
    <circle class="ink" cx="59" cy="16.5" r="3.5"/>`,

  // A page; the lens shows the line under it larger and bolder, and a tick goes in the margin as each line is read.
  // At idle the page is put away, and the lens rests just above the roof with a flare.
  review: () => `
    <g class="paper">
      <path class="part" d="M46 0 H84 L92 8 V44 H46 Z"/>
      <path class="thin" d="M84 0 V8 H92"/>
      <path class="thin" d="M52 10 h12 m3 0 h9 M56 18 h8 m3 0 h12 M52 26 h15 m3 0 h5 M52 34 h9"/>
      <path class="tone tick" stroke-width="2" d="M83 10 l2.5 2.5 4.5 -5"/>
      <path class="tone tick" stroke-width="2" d="M83 18 l2.5 2.5 4.5 -5"/>
      <path class="tone tick" stroke-width="2" d="M83 26 l2.5 2.5 4.5 -5"/>
    </g>
    <g class="lens">
      <path class="line" stroke-width="5" d="M48.22 17.78 l-9.5 9.5"/>
      <circle class="glass" cx="56" cy="10" r="11"/>
      <path class="line zoom" stroke-width="2.5" d="M47.5 10 h8 m2.5 0 h7.5"/>
      <g class="flare">
        <path class="thin glare" d="M48.5 8 q2 -4.5 7 -4.5"/>
        <path class="thin glare" d="M61.5 14.5 q1.5 -1.5 1.8 -3.5"/>
      </g>
    </g>`,

  release: (status) => {
    const cage = `
      <circle class="line" cx="74" cy="6" r="3" stroke-width="1.5"/>
      <path class="line" stroke-width="1.5" d="M60 38 H88"/>`;
    const bars = `
      <path class="line" stroke-width="2" d="M58 44 V24 A16 14 0 0 1 90 24 V44"/>
      <path class="thin" d="M66 44 V12 M74 44 V10 M82 44 V12"/>
      <path class="line" stroke-width="2" d="M56 44 H92"/>`;
    const bird = status === 'failed'
      ? `<g class="bird-down">
           <path class="thin" d="M71 43 v-4 M76 43 v-4"/>
           <ellipse class="bird" cx="73" cy="38" rx="8" ry="4.5"/>
           <circle class="bird" cx="83" cy="39" r="4.2"/>
           <path class="thin" stroke-width="1.2" d="M81.5 37.5 l3 3 M84.5 37.5 l-3 3"/>
         </g>`
      : `<g class="bird-ok">
           <path class="bird" d="M67 30 l-6 3 6 2"/>
           <ellipse class="bird" cx="73" cy="30" rx="7" ry="6"/>
           <circle class="bird" cx="79" cy="24" r="4.5"/>
           <path class="ink" d="M83 22.5 l4 1.5 -4 1.5 z"/>
           <circle class="ink" cx="80" cy="23" r="1.1"/>
           <path class="thin" d="M69 29 q4 4 8 0"/>
         </g>`;
    const note = status === 'passing'
      ? `<g class="note"><circle class="tone-fill" cx="97" cy="12" r="2.4"/><path class="tone" stroke-width="1.75" d="M99.2 12 V2 l4.5 2"/></g>`
      : '';
    return cage + bird + bars + note;
  },

  // A card with a dotted line to sign on; the pen, drawn larger about its nib, signs MR and rests in the inkwell in front.
  verify: () => `
    <g class="paper">
      <rect class="part" x="50" y="4" width="48" height="40" rx="1.5"/>
      <path class="thin" stroke-dasharray="2 2.5" d="M54 31 H94"/>
      <path class="tone sig" transform="translate(57 11)" stroke-width="2" pathLength="100" stroke-dasharray="100" d="${SIG}"/>
    </g>
    <g transform="translate(57 11)">
      <g class="pen">
        <g transform="scale(1.35)">
          <path class="part" d="M2.5 -5.5 L14 -17 L17 -14 L5.5 -2.5 Z"/>
          <path class="ink" d="M0 0 L2.5 -5.5 L5.5 -2.5 Z"/>
          <path class="ink" d="M14 -17 L16.5 -19.5 L19.5 -16.5 L17 -14 Z"/>
        </g>
      </g>
    </g>
    <path class="part" d="M66 44 V38 Q66 35 69 35 H79 Q82 35 82 38 V44 Z"/>
    <rect class="ink" x="71" y="31.5" width="6" height="4" rx="1"/>`,
};

/** Drawn over the chassis: the compass's circle lies across the roof and over its front edge. */
const FRONT: Partial<Record<Kind, (status: Status) => string>> = {
  plan: () => `
    <path class="tone arc" stroke-width="2" pathLength="100" stroke-dasharray="100"
      d="M${NEEDLE.x + CIRCLE.rx} ${NEEDLE.y} a${CIRCLE.rx} ${CIRCLE.ry} 0 0 1 ${-2 * CIRCLE.rx} 0 a${CIRCLE.rx} ${CIRCLE.ry} 0 0 1 ${2 * CIRCLE.rx} 0"/>
    <path class="line needle" stroke-width="2" d="M0 0 V-${f2(LEG)}"/>
    <g class="nib">
      <path class="line" stroke-width="2" d="M0 -5.5 V-${f2(LEG)}"/>
      <path class="tone" stroke-width="3" d="M0 0 V-5.5"/>
    </g>
    <circle class="part hinge" r="4.5"/>`,
};

/* ---- Faces, hatches and extras: how it is doing -------------------------------------- */

const RAYS = `<path class="ray alarm" stroke-width="2" d="M125 11 v-7 M110 19 l-6 -4 M140 19 l6 -4"/>`;
const SMOKE = `<circle class="puff puff-a" cx="44" cy="40" r="3.5"/>
            <circle class="puff puff-b" cx="51" cy="40" r="3.5"/>`;

/** A failure, stopped or working on: sparks off the side, and smoke from behind the tool. The machine rattles too. */
const FAULT = `<g class="sparks">
              <path class="spark" d="M21 95 l-12 -8 M20 103 h-15 M21 111 l-12 8 M25 86 l-5 -12 M25 120 l-5 12"/>
              <path class="spark-core" d="M28 103 l-4 -3 -1 -5 -2 5 -5 1 4 3 -1 5 4 -3 5 1 z"/>
            </g>
            ${SMOKE}`;

const STATE_ART: Record<Status, () => { face: string; hatch: string; extra: string }> = {
  idle: () => ({
    face: `<path class="led" stroke-width="3" d="M59 82 q7 6 14 0 M95 82 q7 6 14 0"/>
           <path class="led" stroke-width="2.5" d="M80 97 h8"/>`,
    hatch: '',
    extra: `<g class="zz"><path d="M140 18 h6 l-6 7 h6"/><path d="M147 22 h4 l-4 5 h4"/></g>`,
  }),
  working: () => ({
    face: `<g class="eyes"><rect class="led-fill" x="62" y="72" width="11" height="19" rx="5.5"/><rect class="led-fill" x="95" y="72" width="11" height="19" rx="5.5"/></g>
           <path class="led" stroke-width="2.5" d="M79 98 h10"/>`,
    hatch: `<rect class="track" x="48" y="126" width="72" height="6" rx="3"/>
            <rect class="tone-fill bar" x="48" y="126" width="72" height="6" rx="3"/>`,
    extra: '',
  }),
  returning: () => ({
    face: `<g class="eyes"><rect class="led-fill" x="55" y="72" width="11" height="19" rx="5.5"/><rect class="led-fill" x="88" y="72" width="11" height="19" rx="5.5"/></g>
           <path class="led" stroke-width="2.25" d="M54 67 q6 -4 12 -2 M88 65 q6 -2 12 2"/>
           <path class="led" stroke-width="2.5" d="M77 98 h10"/>`,
    hatch: `<path class="tone" stroke-width="2.5" d="M100 129 H68 M75 122 l-7 7 7 7"/>`,
    extra: '',
  }),
  passing: () => ({
    face: `<path class="led" stroke-width="3.5" d="M59 86 q7 -11 14 0 M95 86 q7 -11 14 0"/>
           <path class="led" stroke-width="2.5" d="M77 94 q7 6 14 0"/>`,
    hatch: `<path class="tone" stroke-width="3" d="M76 129 l6 6 12 -12"/>`,
    extra: `<path class="tone-fill glint" d="M150 52 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2 z"/>`,
  }),
  blocked: () => ({
    face: `<rect class="led-fill" x="59" y="80" width="14" height="6" rx="3"/><rect class="led-fill" x="95" y="80" width="14" height="6" rx="3"/>
           <path class="led" stroke-width="2.5" d="M58 72 l14 -4 M110 72 l-14 -4"/>
           <path class="led" stroke-width="2.5" d="M78 99 q6 -4 12 0"/>`,
    hatch: `<rect class="tone-fill" x="40" y="118" width="88" height="22" rx="4"/>
            <rect x="40" y="118" width="88" height="22" rx="4" fill="url(#hazard)"/>
            <rect class="frame" x="40" y="118" width="88" height="22" rx="4"/>`,
    extra: RAYS,
  }),
  failed: () => ({
    face: `<path class="led" stroke-width="3.25" d="M60 75 l12 13 M72 75 l-12 13 M96 75 l12 13 M108 75 l-12 13"/>
           <path class="led" stroke-width="2.25" d="M76 99 q3 -3 6 0 t6 0 t6 0"/>`,
    hatch: `<rect class="face rim" x="40" y="118" width="88" height="22" rx="4" stroke-width="1.75"/>
            <text class="fault" x="85" y="133.5" text-anchor="middle">FAULT</text>`,
    extra: RAYS + FAULT,
  }),
};

const CHEV_RIGHT = Array.from({ length: 10 }, (_, i) => `M${-13 + 21 * i} 169l6 5-6 5`).join('');
const CHEV_LEFT = Array.from({ length: 10 }, (_, i) => `M${-7 + 21 * i} 169l-6 5 6 5`).join('');

function render(kind: Kind, status: Status, beacon: Beacon | undefined): string {
  const art = STATE_ART[status]();
  // Only a station at work shows a beacon: blocked and failed draw their own, and idle or passed has nothing to look at.
  const lit = status === 'working' || status === 'returning' ? beacon : undefined;
  const extra = lit === 'failed' ? RAYS + FAULT : lit ? RAYS : '';
  return `
<svg viewBox="0 -20 168 220" class="s-${status} k-${kind}${lit ? ` b-${lit}` : ''}" part="svg" aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="belt-clip"><rect x="0" y="166" width="168" height="16"/></clipPath>
    <pattern id="hazard" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect class="hazard-stripe" width="5" height="10"/>
    </pattern>
  </defs>

  <!-- belt -->
  <rect class="belt" x="0" y="166" width="168" height="16"/>
  <g clip-path="url(#belt-clip)"><g class="belt-run"><path class="chev" d="${status === 'returning' ? CHEV_LEFT : CHEV_RIGHT}"/></g></g>
  <path class="line" stroke-width="1.5" d="M0 166 H168 M0 182 H168"/>
  <circle class="roller" cx="0" cy="174" r="5"/><circle class="roller" cx="168" cy="174" r="5"/>

  <!-- legs stay on the belt; everything above them is the machine -->
  <rect class="steel" x="42" y="146" width="10" height="20"/>
  <rect class="steel" x="116" y="146" width="10" height="20"/>

  <g class="machine" part="machine"><g${status === 'failed' || lit === 'failed' ? ' class="rattle"' : ''}>
  <!-- tool -->
  ${TOOLS[kind](status)}

  <!-- chassis -->
  <rect class="body" x="28" y="44" width="112" height="106" rx="12"/>
  <path class="seam" d="M35 62 V132"/>
  <rect class="face" x="42" y="58" width="84" height="48" rx="8"/>
  <rect class="steel" x="40" y="118" width="88" height="22" rx="4" stroke-width="1.5"/>
  <circle class="ink" cx="36" cy="52" r="1.6"/><circle class="ink" cx="36" cy="142" r="1.6"/><circle class="ink" cx="132" cy="142" r="1.6"/>
  ${FRONT[kind]?.(status) ?? ''}

  <!-- beacon -->
  <rect class="ink" x="116" y="36" width="18" height="8" rx="1.5"/>
  <circle class="beacon-glow" cx="125" cy="31" r="14"/>
  <path class="dome" d="M117 36 a8 8 0 0 1 16 0 z"/>

  <!-- state -->
  ${art.face}
  ${art.hatch}
  ${art.extra}
  ${extra}
  </g></g>
</svg>`;
}

/** A station's state in words: "working", or with a beacon lit, "working, needs you". */
export function describe(status: Status, beacon?: Beacon): string {
  const lit = status === 'working' || status === 'returning' ? beacon : undefined;
  return lit ? `${STATE[status].label}, ${STATE[lit === 'failed' ? 'failed' : 'blocked'].label}` : STATE[status].label;
}

let sheet: CSSStyleSheet | undefined;

export class Station extends HTMLElement {
  static observedAttributes = ['kind', 'status', 'beacon', 'label', 'decorative'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
    }
    this.#root.adoptedStyleSheets = [sheet];
  }

  connectedCallback(): void {
    this.#update();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#update();
  }

  // Properties reflect their attributes, so frameworks that set properties (React does) and markup that sets
  // attributes draw the same thing.
  get kind(): Kind {
    const k = this.getAttribute('kind');
    return KINDS.find((kind) => kind === k) ?? 'build';
  }

  set kind(kind: Kind) {
    this.setAttribute('kind', kind);
  }

  get status(): Status {
    const s = this.getAttribute('status');
    return STATUSES.find((status) => status === s) ?? 'idle';
  }

  set status(status: Status) {
    this.setAttribute('status', status);
  }

  get beacon(): Beacon | undefined {
    const b = this.getAttribute('beacon');
    return BEACONS.find((beacon) => beacon === b);
  }

  set beacon(beacon: Beacon | undefined) {
    if (beacon) this.setAttribute('beacon', beacon);
    else this.removeAttribute('beacon');
  }

  #update(): void {
    const { kind, status, beacon } = this;
    this.#root.innerHTML = render(kind, status, beacon);
    if (this.hasAttribute('decorative')) {
      this.setAttribute('aria-hidden', 'true');
      this.removeAttribute('role');
      this.removeAttribute('aria-label');
    } else {
      this.removeAttribute('aria-hidden');
      this.setAttribute('role', 'img');
      this.setAttribute('aria-label', this.getAttribute('label') || `${STAGE_NAME[kind]}: ${describe(status, beacon)}`);
    }
  }
}

if (!customElements.get('sf-station')) customElements.define('sf-station', Station);
