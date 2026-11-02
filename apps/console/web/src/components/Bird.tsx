/**
 * The canary bird: while a release is in flight it leaves the Release station's cage and keeps the Canary panel
 * company, reacting to each release event as it arrives (`projection/bird.ts` says which reaction each calls for). It
 * is decoration: the panel and the station say everything it does in words, so the whole layer is hidden from
 * assistive tech.
 *
 * Every movement is a Web Animation, which the browser runs by itself. Script runs only between them, at the ends of
 * a flight, a walk or a pause, and reads where the station and the panel are only then, so nothing writes to the page
 * every frame and the console's components never render for it. A reaction that arrives while it is in the air waits
 * for it to land.
 *
 * On opening the console, a release already in flight has the bird on the panel, without a flight: it flies only for a
 * `release.started` that arrives while the page is open. With motion off (the switch, or reduced motion), and at 720px
 * and narrower, where the panel is a screen away from the station, it never flies or walks: it sits on the panel and
 * its notes fade in place.
 */
import type { PublicEvent } from '@software-factory/events';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { hear, heard, type Reaction, type Watch } from '../projection/bird.ts';
import type { Release } from '../projection/release.ts';
import { clamp, type Point, type Route, route, swingOut } from './flight.ts';

/** The bird's box in the station's drawing, whose viewBox is "0 -20 168 220", 168 wide. */
const VB = { x: 56, y: 12, w: 36, h: 30 };
/** Where its feet are, in the drawing: what stands on the panel's top edge. */
const FEET = 39;
const STATION_WIDTH = 168;
/** How long the drawing takes to turn about in the air, as a share of the flight. */
const TURN = 0.02;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const narrow = () => matchMedia('(max-width: 720px)').matches;

type Mode = 'cage' | 'flying' | 'card' | 'down';
type Tone = 'ok' | 'attn' | 'faint';
type Shape = 'single' | 'double' | 'sour';

const NOTE: Record<Shape, string> = {
  single:
    '<svg viewBox="0 0 14 18"><circle class="h" cx="4.5" cy="14" r="3"/><path class="s" d="M7.3 14V3l5 2.2"/></svg>',
  double:
    '<svg viewBox="0 0 20 18"><circle class="h" cx="4" cy="14" r="2.8"/><circle class="h" cx="14.4" cy="12" r="2.8"/><path class="s" d="M6.7 14V3.6l10.4-2.4V12"/></svg>',
  sour: '<svg viewBox="0 0 14 18"><circle class="h" cx="4.5" cy="14" r="3"/><path class="s" d="M7.3 14V10l-1.6-1.8 2.6-1.8-1.6-1.9 1.2-1.5 4 1.6"/></svg>',
};

/** What the bird asks of the page as it goes: whether to move, how fast the canary is going, and its cage. */
interface Page {
  motion: () => boolean;
  /** The canary's share of the traffic: it walks faster the more it has. */
  weight: () => number;
  /** Tells the station its cage is empty, or full again. */
  out: (out: boolean) => void;
}

/** The bird itself: where it is, what it is doing, and what waits for it to land. */
class Flyer {
  readonly #layer: HTMLElement;
  readonly #el: HTMLElement;
  readonly #page: Page;
  #x = 0;
  #y = 0;
  #facing = 1;
  #mode: Mode = 'cage';
  #paper = false;
  /** Moves on when a walk or a pause is cut short, so a loop waiting on one stops. */
  #gen = 0;
  /** Moves on when it starts again from its cage, or stops for good, so a reaction waiting on a sleep stops. */
  #life = 0;
  #anim: Animation | null = null;
  /** The drawing turning about, during a flight that turns back, and where in the flight it turns which way. */
  #turning: { anim: Animation; facings: Route['turns'] } | null = null;
  #queue: (() => void)[] = [];
  /** Out for a release, but with no panel or station to stand on yet: whether it is a paper bird. */
  #waiting: boolean | undefined;

  constructor(layer: HTMLElement, el: HTMLElement, page: Page) {
    this.#layer = layer;
    this.#el = el;
    this.#page = page;
  }

  get mode(): Mode {
    return this.#mode;
  }

  // ---- where things are, read only at the ends of a movement

  #station() {
    return this.#layer.parentElement?.querySelector<HTMLElement>('.stations sf-station[kind="release"]') ?? null;
  }

  #card() {
    return this.#layer.parentElement?.querySelector<HTMLElement>('section.canary') ?? null;
  }

  #scale() {
    const station = this.#station();
    return station ? station.getBoundingClientRect().width / STATION_WIDTH : 1;
  }

  #origin() {
    return this.#layer.getBoundingClientRect();
  }

  /** Where it sits so that it covers the station's own bird. */
  #cage(): Point | undefined {
    const station = this.#station();
    if (!station) return undefined;
    const r = station.getBoundingClientRect();
    const o = this.#origin();
    const s = r.width / STATION_WIDTH;
    return { x: r.left - o.left + VB.x * s, y: r.top - o.top + (VB.y + 20) * s };
  }

  /** The stretch of the panel's top edge it walks, and the height its feet stand at there. */
  #perch(): { lo: number; hi: number; y: number } | undefined {
    const card = this.#card();
    if (!card) return undefined;
    const c = card.getBoundingClientRect();
    const o = this.#origin();
    const s = this.#scale();
    return {
      lo: c.left - o.left + 14,
      hi: c.right - o.left - VB.w * s - 14,
      y: c.top - o.top - (FEET - VB.y) * s + 0.5,
    };
  }

  /**
   * Whether the page is laid out too narrow to stand on, as it is in a window made tiny for a moment (Playwright makes
   * it 1 by 1 for a picture of something taller than the window): the station with no width, or the panel narrower
   * than the bird.
   */
  #cramped(perch: { lo: number; hi: number }) {
    return this.#station()?.getBoundingClientRect().width === 0 || perch.hi < perch.lo;
  }

  /** Where it lands on the panel: under the station, or, on a phone, near the panel's right. */
  #landing(): Point | undefined {
    const perch = this.#perch();
    const station = this.#station();
    if (!perch || !station) return undefined;
    const r = station.getBoundingClientRect();
    const x = narrow() ? perch.hi - 30 : r.left - this.#origin().left + r.width / 2 - (VB.w * this.#scale()) / 2;
    return { x: clamp(x, perch.lo, perch.hi), y: perch.y };
  }

  #still() {
    return !this.#page.motion() || narrow();
  }

  #part(selector: string) {
    return this.#el.querySelector<SVGElement>(selector);
  }

  // ---- placing and moving

  #size() {
    const s = this.#scale();
    this.#el.style.width = `${VB.w * s}px`;
    this.#el.style.height = `${VB.h * s}px`;
  }

  #place({ x, y }: Point) {
    this.#x = x;
    this.#y = y;
    this.#el.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** Turns to face that way: in a moment, or, `instant`, at once, as it lands from a flight that turned about. */
  #face(d: number, instant = false) {
    if (d === this.#facing) return;
    this.#facing = d;
    const flip = this.#part('.flip');
    if (!flip) return;
    if (instant) flip.style.transition = 'none';
    flip.style.transform = `scaleX(${d})`;
    if (instant) {
      // The style takes the turn before the transition is back, so the transition does not play it again.
      void getComputedStyle(flip).transform;
      flip.style.transition = '';
    }
  }

  #beak(): Point {
    const s = this.#scale();
    return { x: this.#x + (this.#facing > 0 ? 31 : 5) * s, y: this.#y + 9 * s };
  }

  #show(out: boolean) {
    this.#el.hidden = !out;
    this.#page.out(out);
  }

  /** Stops a walk or a pause where it is; a loop waiting on it sees the generation move on. */
  #halt() {
    this.#gen += 1;
    const t = this.#turning?.anim;
    this.#turned(t ? Number(t.currentTime ?? 0) / Number(t.effect?.getComputedTiming().duration ?? 1) : 0);
    const a = this.#anim;
    if (a) {
      const m = new DOMMatrixReadOnly(getComputedStyle(this.#el).transform);
      this.#anim = null;
      a.cancel();
      this.#place({ x: m.m41, y: m.m42 });
    }
    this.#el.classList.remove('walking');
  }

  async #move(frames: Keyframe[], options: KeyframeAnimationOptions, to: Point): Promise<boolean> {
    const a = this.#el.animate(frames, { fill: 'forwards', ...options });
    this.#anim = a;
    try {
      await a.finished;
    } catch {
      return false;
    }
    if (this.#anim !== a) return false;
    this.#place(to);
    a.cancel();
    this.#anim = null;
    return true;
  }

  /**
   * Flies a curve with a flutter across it, slower the further it goes (`flight.ts`), swung `swing` pixels aside. It
   * turns about in the air, by a Web Animation of its own, where the curve turns back.
   */
  async #fly(to: Point, swing = 0): Promise<boolean> {
    const r = route({ x: this.#x, y: this.#y }, to, swing);
    const frames: Keyframe[] = r.points.map((p) => ({ transform: `translate(${p.x}px, ${p.y}px)` }));
    this.#mode = 'flying';
    this.#el.classList.add('flying');
    const flip = this.#part('.flip');
    if (flip && r.turns.length) {
      // From the way it faces now: a turn as it takes off, if it needs one, and each in the air, as quick flips of the
      // drawing, held between them.
      const facings = r.facing && r.facing !== this.#facing ? [{ at: 0, facing: r.facing }, ...r.turns] : r.turns;
      const keys: Keyframe[] = [{ transform: `scaleX(${this.#facing})`, offset: 0 }];
      let [was, offset] = [this.#facing, 0];
      for (const { at, facing } of facings) {
        const from = Math.max(offset, at - TURN);
        offset = Math.min(1, from + TURN);
        keys.push({ transform: `scaleX(${was})`, offset: from }, { transform: `scaleX(${facing})`, offset });
        was = facing;
      }
      keys.push({ transform: `scaleX(${was})`, offset: 1 });
      this.#turning = { anim: flip.animate(keys, { duration: r.duration, fill: 'forwards' }), facings };
    } else if (r.facing) this.#face(r.facing);
    const landed = await this.#move(frames, { duration: r.duration, easing: 'linear' }, to);
    this.#el.classList.remove('flying');
    if (landed) this.#turned(1);
    return landed;
  }

  /** Ends a flight's turning about, facing the way it faced `progress` (0 to 1) through the flight. */
  #turned(progress: number) {
    const turning = this.#turning;
    if (!turning) return;
    this.#turning = null;
    const now = turning.facings.findLast(({ at }) => at <= progress);
    if (now) this.#face(now.facing, true);
    turning.anim.cancel();
  }

  /** What arrives while it is in the air waits for it to land. */
  #react(fn: () => unknown) {
    if (this.#mode === 'flying') this.#queue.push(fn);
    else fn();
  }

  #flush() {
    const queue = this.#queue;
    this.#queue = [];
    for (const fn of queue) fn();
  }

  /** Back in its cage, as it is before anything happens. */
  #reset() {
    this.#halt();
    this.#life += 1;
    this.#queue = [];
    this.#waiting = undefined;
    this.#mode = 'cage';
    this.#el.className = 'bird-fly';
    this.#face(1);
    this.#show(false);
  }

  // ---- what it does

  /** A reaction to an event that arrived while the page was open. */
  act(reaction: Reaction) {
    if (reaction.kind === 'leave') {
      void this.#leave(reaction.paper);
      return;
    }
    this.#react(() => {
      if (reaction.kind === 'hop') this.#hop();
      else if (reaction.kind === 'sour') this.#sour();
      else if (reaction.kind === 'sing') void this.#sing(reaction.step);
      else if (reaction.kind === 'trill') void this.#trill();
      else if (reaction.kind === 'keel') void this.#keel();
      else void this.#home();
    });
  }

  /** On the panel already, as the page opens on a release in flight: no flight. */
  perch(paper: boolean) {
    this.#reset();
    this.#clear();
    this.#paper = paper;
    this.#el.classList.toggle('paper', paper);
    this.#size();
    const at = this.#landing();
    // Nothing to stand on yet: it perches as soon as the page has the panel and the station (`settle`).
    if (!at) {
      this.#waiting = paper;
      return;
    }
    this.#place(at);
    this.#show(true);
    this.#mode = 'card';
    if (!this.#still()) void this.#pace();
  }

  /** A release started: it leaves the cage for the panel. */
  async #leave(paper: boolean) {
    this.#reset();
    // A song or a puff of feathers from the release before has no place in this one.
    this.#clear();
    const life = this.#life;
    this.#paper = paper;
    this.#el.classList.toggle('paper', paper);
    this.#size();
    const at = this.#landing();
    const cage = this.#cage();
    if (!at || !cage) {
      this.#waiting = paper;
      return;
    }
    // Still, it is simply on the panel, fading in there if it may move at all.
    const appear = () => {
      this.#place(at);
      this.#show(true);
      if (this.#page.motion())
        this.#el.animate([{ opacity: 0, transform: `translate(${at.x}px, ${at.y - 16}px)` }, { opacity: 1 }], {
          duration: 500,
          easing: 'ease-out',
        });
      this.#mode = 'card';
      this.#flush();
    };
    if (this.#still()) {
      appear();
      return;
    }
    // In the air from the moment it stirs, so what arrives now waits for it to land.
    this.#mode = 'flying';
    this.#place(cage);
    this.#show(true);
    await this.#part('.body')?.animate(
      [{ transform: 'none' }, { transform: 'translateY(-4px)' }, { transform: 'none' }],
      { duration: 260 },
    ).finished;
    if (life !== this.#life) return;
    // Motion switched off as it stirred: it never takes off.
    if (this.#still()) {
      appear();
      return;
    }
    // The cage is just above where it lands: it swings out over the line and back, rather than drop straight down.
    const perch = this.#perch();
    const landed = await this.#fly(at, perch ? swingOut(cage, at, perch.lo, perch.hi) : 0);
    if (life !== this.#life || !landed) return;
    this.#mode = 'card';
    this.#part('.body')?.animate([{ transform: 'scale(1.12, .82)' }, { transform: 'none' }], {
      duration: 300,
      easing: 'cubic-bezier(.3,1.6,.5,1)',
    });
    await sleep(350);
    if (life !== this.#life) return;
    this.#flush();
    if (this.#mode === 'card' && !this.#anim) void this.#pace();
  }

  /** Walks the panel's top edge, faster the more of the traffic the canary has, stopping now and then to look about. */
  async #pace() {
    const g = ++this.#gen;
    while (g === this.#gen && this.#mode === 'card' && !this.#still()) {
      const perch = this.#perch();
      if (!perch) return;
      const dir = Math.random() < 0.5 ? -1 : 1;
      let to = this.#x + dir * (70 + Math.random() * 260);
      if (to < perch.lo || to > perch.hi) to = this.#x - dir * (70 + Math.random() * 260);
      to = clamp(to, perch.lo, perch.hi);
      if (Math.abs(to - this.#x) < 24) {
        await sleep(800);
        continue;
      }
      this.#face(to > this.#x ? 1 : -1);
      await sleep(180);
      if (g !== this.#gen) return;
      const speed = (24 + 0.42 * this.#page.weight()) * this.#scale();
      this.#el.classList.add('walking');
      const walked = await this.#move(
        [{ transform: `translate(${this.#x}px, ${this.#y}px)` }, { transform: `translate(${to}px, ${this.#y}px)` }],
        { duration: (Math.abs(to - this.#x) / speed) * 1000, easing: 'linear' },
        { x: to, y: this.#y },
      );
      this.#el.classList.remove('walking');
      if (!walked || g !== this.#gen) return;
      const head = this.#part('.head');
      const r = Math.random();
      if (head && r < 0.3)
        await head.animate(
          [
            { transform: 'none' },
            { transform: 'rotate(-16deg)', offset: 0.25 },
            { transform: 'rotate(-16deg)', offset: 0.7 },
            { transform: 'none' },
          ],
          { duration: 1000 },
        ).finished;
      else if (head && r < 0.5)
        await head.animate(
          [
            { transform: 'none' },
            { transform: 'rotate(28deg) translateY(1px)', offset: 0.3 },
            { transform: 'none', offset: 0.5 },
            { transform: 'rotate(28deg) translateY(1px)', offset: 0.75 },
            { transform: 'none' },
          ],
          { duration: 700 },
        ).finished;
      if (g !== this.#gen) return;
      await sleep(400 + Math.random() * 1200);
    }
  }

  /** A look landed and nothing failed: a small hop where it is, without stopping. */
  #hop() {
    if (this.#mode !== 'card' || !this.#page.motion()) return;
    this.#part('.body')?.animate(
      [{ transform: 'none' }, { transform: 'translateY(-5px)', offset: 0.4 }, { transform: 'none' }],
      { duration: 320, easing: 'ease-out', composite: 'add' },
    );
  }

  /** A look over its limit: a sour note and a flinch, and it carries on. */
  #sour() {
    if (this.#mode !== 'card') return;
    this.#note(this.#beak(), { tone: this.#paper ? 'faint' : 'attn', shape: 'sour', drift: this.#facing * 10 });
    if (this.#page.motion())
      this.#part('.body')?.animate(
        [{ transform: 'none' }, { transform: 'rotate(-8deg)' }, { transform: 'rotate(6deg)' }, { transform: 'none' }],
        { duration: 360, composite: 'add' },
      );
  }

  /** A step passed: it stops, looks up and sings, a note more and a little higher for each step. */
  async #sing(step: number) {
    if (this.#mode !== 'card') return;
    this.#halt();
    const [g, life] = [this.#gen, this.#life];
    if (this.#page.motion())
      this.#part('.head')?.animate(
        [
          { transform: 'none' },
          { transform: 'rotate(-22deg)', offset: 0.15 },
          { transform: 'rotate(-22deg)', offset: 0.85 },
          { transform: 'none' },
        ],
        { duration: 400 + 260 * (step + 1) },
      );
    const at = this.#beak();
    for (let k = 0; k <= step; k++)
      this.#note(at, {
        tone: this.#paper ? 'faint' : 'ok',
        rise: 40 + 16 * step + 12 * k,
        drift: this.#facing * (10 + 6 * k),
        delay: k * 220,
      });
    await sleep(1300 + 220 * step);
    if (g === this.#gen && life === this.#life && this.#mode === 'card') void this.#pace();
  }

  /** Promoted: a trill, then home. */
  async #trill() {
    if (this.#mode !== 'card') return;
    this.#halt();
    const life = this.#life;
    const at = this.#beak();
    const shapes: Shape[] = ['single', 'double', 'single', 'double', 'single'];
    shapes.forEach((shape, k) => {
      this.#note(at, {
        tone: this.#paper ? 'faint' : 'ok',
        shape,
        rise: 56 + 14 * k,
        drift: this.#facing * (6 + 9 * k) * (k % 2 ? 1 : 0.6),
        delay: k * 150,
      });
    });
    if (this.#page.motion())
      this.#part('.body')?.animate(
        [
          { transform: 'none' },
          { transform: 'translateY(-7px)' },
          { transform: 'none' },
          { transform: 'translateY(-5px)' },
          { transform: 'none' },
        ],
        { duration: 700 },
      );
    await sleep(2200);
    if (life === this.#life) await this.#home();
  }

  /** Rolled back: a sour note, it keels over, then shakes it off and flies home ruffled. */
  async #keel() {
    if (this.#mode !== 'card') return;
    this.#halt();
    const life = this.#life;
    const moving = this.#page.motion();
    this.#mode = 'down';
    this.#note(this.#beak(), { tone: this.#paper ? 'faint' : 'attn', shape: 'sour', drift: this.#facing * 10 });
    const body = this.#part('.body');
    if (moving && body)
      await body.animate([{ transform: 'none' }, { transform: 'rotate(-30deg)' }], {
        duration: 240,
        easing: 'ease-in',
      }).finished;
    if (life !== this.#life) return;
    this.#el.classList.add('down');
    if (moving) {
      this.#part('.keeled')?.animate([{ transform: 'translateY(-4px)' }, { transform: 'none' }], {
        duration: 260,
        easing: 'cubic-bezier(.3,1.8,.5,1)',
      });
      this.#part('.keeled path')?.animate(
        [{ transform: 'none' }, { transform: 'translateY(-1px)' }, { transform: 'none' }],
        {
          duration: 260,
          delay: 900,
          iterations: 3,
        },
      );
    }
    await sleep(2400);
    if (life !== this.#life) return;
    this.#el.classList.remove('down');
    if (!moving || !body) {
      await sleep(400);
      if (life === this.#life) await this.#home();
      return;
    }
    await body.animate(
      [
        { transform: 'none' },
        { transform: 'rotate(-12deg)' },
        { transform: 'rotate(12deg)' },
        { transform: 'rotate(-9deg)' },
        { transform: 'rotate(7deg)' },
        { transform: 'none' },
      ],
      { duration: 520 },
    ).finished;
    if (life !== this.#life) return;
    const s = this.#scale();
    this.#feathers({ x: this.#x + 17 * s, y: this.#y + 16 * s });
    this.#el.classList.add('ruffled');
    await sleep(700);
    if (life === this.#life) await this.#home();
  }

  /** Back to the cage: flown, or, still, simply there again. */
  async #home() {
    // Out for a release it never stood on the panel for: there is nothing to fly back.
    if (this.#mode !== 'card' && this.#mode !== 'down') {
      this.#reset();
      return;
    }
    this.#halt();
    const life = this.#life;
    const cage = this.#cage();
    if (!this.#still() && cage) {
      const landed = await this.#fly(cage);
      if (life !== this.#life || !landed) return;
    }
    this.#reset();
  }

  /** Where the page has moved under it (a resize, something above growing), it stands where it should again. */
  settle() {
    if (this.#mode === 'cage' && this.#waiting !== undefined) this.perch(this.#waiting);
    if (this.#mode !== 'card' && this.#mode !== 'down') return;
    const perch = this.#perch();
    // Clamped into a stretch too short to stand on, it would stay where that put it once the page is back: out of
    // sight meanwhile, it keeps its place.
    if (!perch || this.#cramped(perch)) {
      this.#el.hidden = true;
      return;
    }
    this.#el.hidden = false;
    const width = `${VB.w * this.#scale()}px`;
    const x = clamp(this.#x, perch.lo, perch.hi);
    if (width === this.#el.style.width && Math.abs(perch.y - this.#y) < 0.5 && x === this.#x) return;
    this.#halt();
    this.#size();
    this.#place({ x, y: perch.y });
    if (this.#mode === 'card') void this.#pace();
  }

  /**
   * Motion switched on or off: it stops where it is, or walks again. Switched off in the air, it is where it was going
   * at once (the flight's own end, so what follows a landing follows), and a flight switched on stays as it was.
   */
  motion() {
    if (this.#mode === 'flying') {
      if (this.#still()) this.#anim?.finish();
      return;
    }
    if (this.#mode !== 'card') return;
    this.#halt();
    if (!this.#still()) void this.#pace();
  }

  /** Stops for good, as the page goes: nothing it started goes on. */
  stop() {
    this.#reset();
    this.#life += 1;
    this.#clear();
  }

  /** Takes away the notes and feathers still in the air. */
  #clear() {
    for (const el of this.#layer.querySelectorAll('.bird-note, .bird-feather')) el.remove();
  }

  // ---- notes and feathers

  #note(at: Point, { tone, shape = 'single', rise = 46, drift = 12, delay = 0 }: NoteOptions) {
    const n = document.createElement('div');
    n.className = `bird-note ${tone}${shape === 'double' ? ' double' : ''}`;
    n.innerHTML = NOTE[shape];
    n.style.left = `${at.x}px`;
    n.style.top = `${at.y}px`;
    this.#layer.append(n);
    const c = 'translate(-50%, -100%)';
    // Still, a note fades in and out where it is; moving, it rises and drifts, and a sour one wobbles.
    const frames: Keyframe[] = this.#still()
      ? [
          { transform: `${c} translate(${drift * 0.6}px, -10px)`, opacity: 0 },
          { opacity: 1, offset: 0.15 },
          { opacity: 1, offset: 0.8 },
          { transform: `${c} translate(${drift * 0.6}px, -10px)`, opacity: 0 },
        ]
      : shape === 'sour'
        ? [
            { transform: `${c} scale(.6)`, opacity: 0 },
            { transform: `${c} translate(${drift / 2}px, -18px) rotate(-14deg)`, opacity: 1, offset: 0.25 },
            { transform: `${c} translate(${drift}px, -14px) rotate(12deg)`, offset: 0.5 },
            { transform: `${c} translate(${drift}px, -4px) rotate(-8deg)`, opacity: 0 },
          ]
        : [
            { transform: `${c} scale(.5)`, opacity: 0 },
            { transform: `${c} translate(${drift * 0.3}px, ${-rise * 0.25}px) scale(1)`, opacity: 1, offset: 0.18 },
            { transform: `${c} translate(${drift}px, ${-rise}px) rotate(${drift > 0 ? 12 : -12}deg)`, opacity: 0 },
          ];
    n.animate(frames, {
      duration: this.#still() ? 2200 : 1700,
      delay,
      easing: 'cubic-bezier(.2,.6,.3,1)',
      fill: 'both',
    }).finished.then(
      () => n.remove(),
      () => n.remove(),
    );
  }

  #feathers(at: Point) {
    if (!this.#page.motion()) return;
    for (let i = 0; i < 5; i++) {
      const f = document.createElement('div');
      f.className = 'bird-feather';
      f.style.left = `${at.x}px`;
      f.style.top = `${at.y}px`;
      this.#layer.append(f);
      const a = -Math.PI * (0.15 + 0.7 * (i / 4));
      const d = 18 + Math.random() * 14;
      const [dx, dy] = [Math.cos(a) * d, Math.sin(a) * d];
      f.animate(
        [
          { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) rotate(${90 + i * 40}deg)`, opacity: 1, offset: 0.35 },
          { transform: `translate(${dx * 1.5}px, ${dy + 34}px) rotate(${200 + i * 50}deg)`, opacity: 0 },
        ],
        { duration: 1500, easing: 'ease-out', fill: 'both' },
      ).finished.then(
        () => f.remove(),
        () => f.remove(),
      );
    }
  }
}

interface NoteOptions {
  tone: Tone;
  shape?: Shape;
  rise?: number;
  drift?: number;
  delay?: number;
}

interface BirdProps {
  /** Every event, as the page holds them. */
  events: readonly PublicEvent[];
  /** Whether events arrive as they happen: a recording, or a page pinned to a time, has none arrive. */
  live: boolean;
  /** The release in flight at the time the page draws, if one is. */
  release: Release | undefined;
  motion: boolean;
  /** Tells the line whether the Release station's cage is empty. */
  onOut: (out: boolean) => void;
}

/**
 * The layer the bird flies in, just before the line. What is held when it mounts is history: a release in flight then
 * has the bird on the panel already. Every event after the last held then arrived while the page was open, and the
 * bird reacts to it. The full events Martin reads take over from the public ones with the same seqs, so they are
 * history too.
 */
export function Bird({ events, live, release, motion, onOut }: BirdProps) {
  const layer = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const flyer = useRef<Flyer | null>(null);
  const heardSoFar = useRef<{ seq: number; watch: Watch } | null>(null);
  const page = useRef({ motion, weight: release?.weight ?? 0, onOut });
  page.current = { motion, weight: release?.weight ?? 0, onOut };

  // Before the page is painted, so a release in flight never shows its bird in the cage for a frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: what the page holds as it opens is read once
  useLayoutEffect(() => {
    if (!layer.current || !el.current) return;
    const bird = new Flyer(layer.current, el.current, {
      motion: () => page.current.motion,
      weight: () => page.current.weight,
      out: (out) => page.current.onOut(out),
    });
    flyer.current = bird;
    heardSoFar.current = { seq: events.at(-1)?.seq ?? 0, watch: heard(events) };
    if (release) bird.perch(release.dryRun);
    // Wherever the page moves under the bird, it stands where it should again.
    const parent = layer.current.parentElement;
    const observer = new ResizeObserver(() => bird.settle());
    if (parent) observer.observe(parent);
    return () => {
      observer.disconnect();
      bird.stop();
      flyer.current = null;
    };
  }, []);

  useEffect(() => {
    const bird = flyer.current;
    const so = heardSoFar.current;
    if (!bird || !so) return;
    // Only the newest are new: find where they start from the end.
    let from = events.length;
    while (from > 0 && (events[from - 1]?.seq ?? 0) > so.seq) from -= 1;
    for (const event of events.slice(from)) {
      const reaction = hear(so.watch, event);
      if (reaction && live) bird.act(reaction);
      so.seq = event.seq;
    }
  }, [events, live]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the bird reads motion through the ref; this tells it it changed
  useEffect(() => flyer.current?.motion(), [motion]);

  return (
    <div className="bird-layer" ref={layer} aria-hidden="true">
      <div className="bird-fly" ref={el} hidden>
        <svg className="flip" viewBox="56 12 36 30" aria-hidden="true">
          <g className="bob">
            <g className="body">
              <g className="upright">
                <path className="thin legs" d="M71.5 35.5 l-1 3.5 M75.5 35.5 l.8 3.5" />
                <path className="bird" d="M67 30 l-6 3 6 2" />
                <ellipse className="bird" cx="73" cy="30" rx="7" ry="6" />
                <path className="thin fold" d="M69 29 q4 4 8 0" />
                <path className="bird wing" d="M71 28.5 q2 -10 11 -11 q-1 9 -11 11z" />
                <g className="head">
                  <circle className="bird" cx="79" cy="24" r="4.5" />
                  <path className="ink" d="M83 22.5 l4 1.5 -4 1.5 z" />
                  <circle className="ink" cx="80" cy="23" r="1.1" />
                  <path className="thin tuft" d="M77 19.9 l-1.2 -2.4 M79 19.5 v-2.6 M81 19.9 l1.3 -2.2" />
                </g>
              </g>
              <g className="keeled">
                <path className="thin" d="M70 31.5 l-1.2 -4 M76 31.5 l1.2 -4" />
                <ellipse className="bird" cx="73" cy="35" rx="8" ry="4" />
                <circle className="bird" cx="83" cy="35.5" r="4" />
                <path className="thin" strokeWidth="1.2" d="M81.5 34 l3 3 M84.5 34 l-3 3" />
              </g>
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}
