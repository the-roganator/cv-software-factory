# Paper & Ink: the Software Factory design system

The console's visual language: colour roles, type, spacing and the station kit. Version 0.1: enough to build the console skeleton and the line; the gaps are listed at the end.

Open [`index.html`](index.html) to see it: every token, both themes, the mark, and every station in every state. The console mockup built from it is [`../mockups/console.html`](../mockups/console.html): plain HTML, CSS and JS, and the reference for `apps/console`.

## Files

| File | What it is | Edit? |
|---|---|---|
| [`tokens.json`](tokens.json) | Source of truth: colour roles per theme, type, space, radius, stroke, shadow, motion, station geometry. W3C Design Tokens (DTCG) format. | Yes |
| [`tokens.css`](tokens.css) | Custom properties and `.t-*` type classes, generated from the JSON. | No: run `build.ts` |
| [`properties.css`](properties.css) | The custom properties alone, Paper at the root and Ink by its attribute: what the console imports, without the `.t-*` classes it does not use. | No: run `build.ts` |
| [`build.ts`](build.ts) | `node docs/design/system/build.ts` (Node 24, no dependencies) regenerates `tokens.css`, `properties.css` and `station.js`, and fails if any meaningful colour pair drops below WCAG 2.2 AA. With `--check` it writes nothing and fails if any is out of date; `make check` runs it that way. | Yes |
| [`station.ts`](station.ts) | The `<sf-station>` element: the station kit, which the console imports as it is. No `<style>` element or `style` attribute, so it runs under the console's content security policy. | Yes |
| [`station.js`](station.js) | The same element as a classic script, so design pages open from disk. | No: run `build.ts` |
| [`mark/`](mark/) | The MR monogram: `mark.svg` (Paper), `mark-ink.svg` (Ink), `icon.svg` (favicon and app icon). | Replace, don't edit |
| [`index.html`](index.html) | Specimen page. Opens from disk; `?theme=ink` and `?motion=off` work. | Yes |

The console mockup links `tokens.css` and `station.js` directly, so a change here shows up there on reload.

## Principles

1. **Moving is not news.** Work in flight is neutral ink (`signal`). A busy line looks calm; only a finished, verified result earns green (`ok`).
2. **One warm colour.** `attn` means a person should look: Needs you, a held PR, a failure, a rollback, Stop the line. Nothing else is warm. The one exception is the canary, which is yellow because it is a canary and carries no meaning.
3. **Read it like a log.** Ids, clocks, figures and labels are Geist Mono, tabular. Prose and controls are Geist. Names and headlines are Instrument Serif.
4. **Shape, then colour, then motion.** Every state is distinguishable in greyscale and with motion off. Colour confirms; motion adds life and always stops when asked.

## Colour

Components use role names only, never hex values. Each theme assigns every role, so switching theme is one attribute: `<html data-theme="ink">` (or the class `theme-ink` on any container).

**Paper always comes first.** Every visit opens in Paper, whatever the visitor's system setting. Ink is offered by a switch in the header (in Martin's account menu while he is signed in) and is not remembered between visits.

| Role | Use for | Never for |
|---|---|---|
| `bg`, `surface`, `raised` | Page, panels and belt, cards and popovers | |
| `line`, `line-strong` | Hairlines; control borders | Text |
| `text`, `text-2`, `text-muted` | Body; secondary; labels and captions (lowest contrast allowed for meaningful text) | |
| `text-faint` | Disabled, idle, chart baselines | Anything that must be read |
| `signal` (+ `on-signal`, `-hover`, `-wash`, `-line`) | Work in flight, primary buttons, focus rings | Success or alarm |
| `ok` (+ `on-ok`, `-wash`, `-line`, `-text`) | Healthy, passed, verified, canary checks passing | Things merely in progress |
| `attn` (+ `on-attn`, `-wash`, `-line`) | Needs you, held, blocked, failed, rolled back, aborted, Stop the line | Decoration, links, brand |
| `station-face`, `station-led-*` | The station's LED face (always dark) and its glyphs | Anything outside a station |
| `station-canary` | The Release station's bird | Anything else |
| `scrim` | Dimming the page behind the sheet | Anything that carries meaning |

The pattern for "needs you" in cards is a 2px `attn` rule on the left edge (`radius-rule` on that side), not a filled box. The reel's cards are the exception: their outcome dot flashes instead. A stage panel's rows take the same rule: `attn` on a row held or failed, and `ok`, built the same way, on a row verified at Verify.

`build.ts` checks these pairs in both themes: text roles on `bg`, `raised` and `surface` at 4.5:1; `on-*` on their fills at 4.5:1; station linework and LED glyphs at 3:1 (WCAG 1.4.11, graphics). Add a pair when you add a role that carries meaning.

## Type

| Class | Face | Size / line | Use |
|---|---|---|---|
| `t-display` | Instrument Serif | 58 / 1, −1px | App name on the console |
| `t-title` | Instrument Serif | 32 / 1.05 | Panel and work-item titles |
| `t-heading` | Instrument Serif | 26 / 1 | Popover and card headings |
| `t-stage` | Instrument Serif | 23 / 1.1 | Stage names under the stations |
| `t-subtitle` | Instrument Serif italic | 22 | One line of voice under a title |
| `t-body` | Geist | 15 / 1.4 | Prose |
| `t-ui` | Geist | 13 / 1.4 | Buttons, rows, controls |
| `t-caption` | Geist | 12 / 1.45 | Help text, "What am I looking at?" |
| `t-figure` | Geist Mono, tabular | 28 / 1.2 | Scoreboard numbers |
| `t-clock` | Geist Mono, tabular | 24 | The scrubber clock |
| `t-data` | Geist Mono | 11 | Ids, stats, log lines |
| `t-label` | Geist Mono caps, +1.2px | 10.5 | Section labels and kickers |

All three faces are on Google Fonts; self-host them in the app (woff2, `font-display: swap`) so the console has no third-party requests. Sizes are for the 1440 desktop layout; the phone scale is not designed yet.

## Space, shape, motion

- **Space:** a 4px base, written in pixels where it is used (`12px` says as much as a token would, in fewer characters); the page's gutter, 48px at desktop, is the one token, `--space-gutter`.
- **Radius:** 2 (the Needs-you edge), 4 (small controls), 6 (cards, buttons), 8 (panels, popovers), pill.
- **Stroke:** 1px hairlines; 2px for the Needs-you rule, focus rings and the station chassis; 1.75px for station tools.
- **Elevation:** flat. The only shadow is `--shadow-popover`, for panels that float over the line and for the sheet.
- **Motion:** everything stops under `prefers-reduced-motion: reduce` and when the console's motion switch is off, and the still pose must say the same thing. Alarms flash at 0.9s, well under three flashes a second. Flows use `--motion-flow` (1.1s); easing is `--motion-ease`.

## Stations

One station per stage, in the order and names of [`TERMS.md`](../../TERMS.md): Sense, Triage, Plan, Build, Gates, Review, Release, Verify. Each is drawn in a 168 × 220 box, so eight make one continuous 1344px belt: the console's line.

```html
<sf-station kind="gates" status="blocked"></sf-station>             <!-- names itself: "Gates: needs you" -->
<button aria-label="Gates: needs you, 2 PRs. Show what is in this stage">
  <sf-station kind="gates" status="blocked" decorative></sf-station> <!-- the button names it -->
</button>
```

| Attribute | Values |
|---|---|
| `kind` | `sense` `triage` `plan` `build` `gates` `review` `release` `verify` |
| `status` | `idle` `working` `returning` `passing` `blocked` `failed` |
| `beacon` | `needs-you` `failed`: a person should look while the machine works on (below) |
| `motion` | `off` draws the still pose |
| `bird` | `out` empties the Release station's cage, while the console draws its bird elsewhere (below) |
| `label` | Overrides the accessible name |
| `decorative` | Hides it from assistive tech when something else names it |

Width scales the drawing (`sf-station { width: 140px }`); height follows.

### What each part says

| Part | Says | idle | working | returning | passing | blocked | failed |
|---|---|---|---|---|---|---|---|
| **Tool** | What the stage does | still (Review's page and Verify's card put away) | moving, once the page or card has come up | moving | still (gate raised, page ticked, canary sings, card signed) | still | still (canary down) |
| **Face** | How it feels | eyes shut | busy eyes, blinking | glancing back | pleased | squinting | crossed out |
| **Hatch** | Progress | blank | progress bar | left arrow | tick | hazard stripes | FAULT |
| **Beacon** | Whether to look | dim | ink | ink | green glow | flashing ember, rays | flashing ember, rays, sparks, smoke; the machine rattles |
| **Belt** | Flow | still | forward | backwards | forward, slower | still | still |
| **Caption word** | | idle | working | sending back | passed | needs you | failed |
| **Tone role** | | `text-faint` | `signal` | `signal` | `ok` | `attn` | `attn` |

Blocked and failed share `attn` on purpose: both mean a person should act. Their hatch, face, sparks and smoke tell them apart. The rattle comes in a short burst every few seconds and moves the machine, never the belt; with motion off, the sparks and smoke still say it.

### At work, and needing you

The status says what the machine is doing; the beacon says whether a person should look. A station can be at work on one item while another waits for you, so `beacon` lights the alarm on a working or returning station without stopping it: the tool, face, hatch and belt say it is at work, and only the beacon takes `attn`. `beacon="needs-you"` adds the flashing ember and rays; `beacon="failed"` adds the sparks and smoke too, and the rattle. Only a working or returning station shows it: blocked and failed light their own, and an idle or passed station has nothing to look at. The accessible name says both: "Plan: working, needs you".

### From events to a station's status

The console's projection (`apps/console/web/src/projection/line.ts`) works out each station's status from the work items in the stage at time *t*, taking the first rule that matches:

1. **failed:** an item in the stage failed (a gate run, a refusal, a rollback) and nothing has happened since: no retry, no return, no hold for a human; and nothing else in the stage is in progress.
2. **blocked:** an item is waiting on a human (spec approval, held PR, planner question, a visitor's suggestion parked for Martin, a planner's finding parked for him at Triage, a spec that goes beyond its ticket at Review), and nothing else in the stage is in progress; or, at Triage, a spend cap holds, whatever is in progress, since nothing calls a model under a cap.
3. **returning:** an item was sent upstream from this stage in the last 5 minutes.
4. **working:** at least one item is in progress in the stage. A ticket waiting for the planner is in Plan but not in progress: nobody is at work on it.
5. **passing:** an item left the stage for a later one, or was verified in it, in the last 15 minutes, and nothing is in progress.
6. **idle:** otherwise.

Then the beacon: `failed` if an item failed in the stage, as in rule 1, otherwise `needs-you` if an item waits on a human, as in rule 2. Only a working or returning station shows it, since one that failed or is blocked already says so. The caption's word follows the beacon when it is lit, so it always names what a person has to do: "needs you" or "failed".

A failure that a mechanism hands to a human (the test-integrity gate holding a pull request) reads as `blocked`, not `failed`: someone should look, and the hatch says why. Under Stop the line, every station shows `blocked` and the belt stops.

An item whose last step is `ticket.opened` has left Triage and sits at Plan, waiting for the planner, until something happens there; another sense's evidence or a report that repeats the ticket does not take it back up the line. At a spend cap (`spend.capped`, until `spend.cleared`), Triage uses the blocked drawing with its own word, **capped**: it takes no reports until the cap resets, and the senses' tickets still open, because they call no model.

The figure in each caption counts the items in the stage (`2 PRs`), gives a canary's weight at Release (`25%`, a release with no work item's too), says how many are held (a mechanism stopped them) or waiting (the line asked Martin something) when the station is blocked or its beacon says it needs you, counts the tickets queued for an idle stage (`7 waiting`), gives a cap's reset time at a capped Triage (`until 01:00`), and otherwise counts what left the stage today (`3 today`), or says `none`.

### On the line

- Stations sit edge to edge; the rollers at each seam hide the belt joints.
- Parcels (14 × 12, `surface` fill, `text` stroke) ride on the belt top (`--station-belt-top`, 186px), pile up in front of a station that needs you (with one running through it as well, while it works on another), and queue, up to three, in front of an idle station with tickets waiting for it. They are decorative; the counts live in the captions and the stage panel.
- **Returns** are drawn as a dashed `signal` arc over the stations, from the sender back to the receiver, with a one-line label in a small pill (return icon, `t-data`). There are two kinds: a stage sending work back (Review → Build, Gates → Build, Verify → Plan when a signal persists), and Verify feeding new tickets from production back to Sense.
- **A return stays only while it is true.** It is drawn until its work item moves on: its next event that moves it to a stage, a hold, or its close. After that it is a row in the sender's panel, and no longer an arc.
- **One return at a time.** Returns queue newest first and show for about five seconds each, fading in and out. While its arc shows, the sender's station and caption switch to `returning`. With motion off, the newest return holds still. Under Stop the line, none show. Returns are fleeting, so each one is also written as a row in the sender's stage panel.
- **The whole station is the hit target** (a `<button>` wrapping station and caption). Hover lifts the machine 3px through `::part(machine)`; the legs and belt never move, so the line stays continuous. When the stage panel is open, the stage name gets a 2px underline.
- **Entry points sit on the stage they feed.** Admin sees a round `signal` + on Plan (request an improvement), repeated as a button in the Plan panel. Triage's panel lists what it takes work from, after its work: the six senses as rows (the probes, the crawler, metrics and logs watch the stable version; reports are what visitors send; the canary is a release's analysis, which signals when it rolls a release back), each with the signals that became events and the tickets they opened, counted from events alone (so live and replay agree), reports broken down by where triage sent them, and a line saying a sense's repeats within a version are counted by the inbox, not here. A zero is written as `0`, in `text-muted`. Sources that aren't built for the demo (Slack, Linear or Jira) are shown with a dashed border and "not in the demo".
- **A stage panel lists the work first**, the same at every station: the header and blurb, then one list of rows with no group labels, then the station's reference material under a hairline (Triage's sources, Plan's note that tickets wait for the planner). Of the items in the stage now, the list gives what the station is working on, then what is held or failed there, then what waits for it to take it; after them, under a `line-strong` hairline, those that left it today. Each group is newest first, by work-item number. A work item is one row, with its state now; an earlier state it went through today is kept in the row, struck through ("~~sent back~~ · verified"), and read to a screen reader as "earlier". A spend cap that holds is a row with the work, ruled as held; one that cleared today sits with what left today, written as returns are, so anyone who missed it can still see it happened.
- **Each row has a status icon** under its number (or "cap", or a release's version), left-aligned with its first character, 3px below it: 12px, drawn as the console's glyphs are (round caps and joins, 1.5px stroke), the shapes solid and the tick stroked. It is hidden from a screen reader, since the note says the state in words. They are media-player signs, so they read without a key:

  | Row | Icon | Row style |
  |---|---|---|
  | In hand | Play, `signal` at full strength, blinking at `--motion-blink` (still with motion off); `text-faint` and still while the station is stopped, capped or held | Note in `text`; a screen reader hears "working" |
  | Held or failed | Stop, `attn` | The `attn` rule; note in `attn` |
  | Waiting | Pause, `text-faint` | Plain |
  | Passed on today | Next, `text-faint` | Title and note in `text-muted` |
  | Sent back upstream today | Previous, `text-faint` | Title and note in `text-muted` |
  | Verified at Verify | Tick, `ok` | The `ok` rule; note in `ok`, title in `text` |

  A work item still in the stage that was sent back earlier takes its state now's icon; its struck-through earlier state says the rest.
- Under each station: stage name (`t-stage`), a dot and the state word, then the stage's figures and controls. The word is always there, so colour is never the only signal.

### In the app

`station.ts` is a dependency-free custom element, used from the console's JSX as it is (ADR 0007): one constructed stylesheet shared by every station, and a drawing of classes and presentation attributes. The console's policy refuses styles written into markup, but allows those set through the CSSOM: a constructed stylesheet, or an element's `style` property. Each kind in each state, in both themes, has a visual-regression snapshot (96 images), and axe checks the line.

## The reel and the sheet

Work items are shown as a **reel**: one card per work item, oldest on the left and now on the right, scrubbed sideways. Opening a card raises its **sheet** from the bottom of the screen, with everything about that work item.

### The reel

- **One card in the centre**, its neighbours either side at 90% scale and lower opacity, fading out at the reel's edges. Drag the cards, flick them, use the arrow keys, or drag the **timeline** underneath; release snaps to the nearest card. Clicking a neighbour brings it to the centre; clicking the centre card opens its sheet.
- **The timeline** has one mark per work item, in its category glyph and outcome tone, a hairline at the start of each day, the version each release left the app on, once it has ended (a version rolled back, stopped with the line or aborted by Martin is struck through, a release with no work item is marked by its version alone, at its time, and a dry run's release marks nothing), and a playhead. It shows a window of itself around the playhead, the same at every width: each mark has at least 40px, so none overlaps another; when the whole timeline does not fit at that, it slides to keep the playhead in the middle, and an end fades where the timeline goes on past it. Day and version labels that would touch become hairlines. Under it, one line says when the centre card happened and what version the app was then, and, when the work item's own release was rolled back or stopped, says so in words ("v0.9.1 was rolled back"), so a strike-through is never the only sign. The timeline is a slider, and its value says the same: the work item, when, and the app's version.
- **Previous, next and Now** above the reel step it a card at a time and bring it back to the latest work item, beside a count ("72 of 74"). The reel opens at now and moves only when the viewer moves it: nothing plays it. With motion off, the cards move without animating.
- **Needs you** cards (waiting on Martin, or held for a human) flash their outcome dot at `--motion-alarm`, like a station's beacon, and hold it still with its ring when motion is off. They take no edge rule: the picture often carries one already.

### A card

Top to bottom, and nothing else:

1. **Category and kind** on the left (glyph, `t-label` caps, then the kind in `t-caption`); **outcome** on the right: dot and word, in the outcome's tone. Work a visitor started says so ("Injected by a visitor", "Red-team attack by a visitor"), never which visitor.
2. **The picture**, 16:10. See below.
3. **Title** in Instrument Serif 28, and a description clamped to two lines.
4. **One line of facts** in `t-data`: number, an improvement's flag glyph and its stage ("⚑ preview", or "off"), version (a pill), pull request, start, duration, model spend. Before a release, the pill says what a sense saw it on ("seen on v0.9.3") or, for a visitor's report, the page it came from at its path only ("from /about"). After a release that did not ship, rolled back or aborted, the pill strikes its version through and points to the one the app stayed on (~~v0.9.11~~ → v0.9.10), with how it ended in visually hidden text for a screen reader; the sheet's Version fact spells it out: "v0.9.10 · rolled back · stayed on v0.9.9", "v0.9.11 · stopped with the line · stayed on v0.9.10" or "v0.9.11 · aborted by Martin · stayed on v0.9.10". Work that called no model says "no model", not "$0.00".
5. **Eight segments**, one per stage: `ok` for passed, a dashed outline for skipped, a solid `text-muted` outline for queued (a ticket waiting for the planner, or a merged fix waiting for a release), `signal` (blinking) for now, `attn` where it stopped or waits on a human, `text-muted` where triage closed it, and `ok` where a red-team attack's mechanism refused it, the stages before it skipped. The segments have an accessible label such as "Stopped at Release" or "Refused at Gates".

The outcomes, each a word and a tone. Work nobody needs to act on is in the quiet tone:

| Outcome | Word | Tone and dot |
|---|---|---|
| Verified | Verified | `ok` |
| Rolled back | Rolled back | `attn`, ringed |
| Held for a human, Needs you | Held for a human, Needs you | `attn`, flashing |
| In progress | In progress | `signal`, blinking |
| A ticket waiting for the planner | Waiting for the planner | `text-muted`, hollow |
| A fix Martin merged, its deploy pull request's checks passed | Needs you | `attn`, flashing: while the factory is Supervised, the deploy pull request is Martin's to merge. The same after the release that carried it rolled back, once the next one's checks pass, and at once after it was aborted, for his retry |
| A fix Martin merged, its deploy not his to merge yet | Merged · waiting for its deploy | `text-muted`, hollow: no deploy pull request yet (its image is being built and signed), its checks running or failed, merged and waiting for Argo CD, or closed for the next build's |
| A ticket open again after it was verified | Its outcome now, with an outline REOPENED pill before it | The outcome's own |
| Closed with no change | Closed · no change | `text-muted` |
| A report that described nothing wrong | Closed · no ticket | `text-muted` |
| A report that gave orders to the system | Quarantined | `text-muted`: a guardrail worked, and nobody needs to act |
| A visitor's suggestion, parked for Martin | Needs you | `attn`, flashing; Triage says "needs you" too |
| An improvement whose flag Verify has checked at its stage, waiting for Martin to widen it | Needs you | `attn`, flashing; Verify says "needs you" too |
| An improvement turned off before everyone had it | Turned off | `text-muted`: Martin's choice, and nothing failed |
| A red-team attack its mechanism refused | Refused | `ok`: the refusal is the result the attack exists to show |
| A red-team attack nothing refused | Not refused | `attn`, ringed: a guardrail failed, and Martin's phone was paged |

### The picture

The picture is evidence, so it is always something the factory captured, never an illustration.

| Work | Picture |
|---|---|
| A visible change | Screenshots before and after, with a **wipe** between them: a 2px `signal` divider and a round handle (drag it, or arrow keys on it). Each side is its own stacking context, so nothing drawn on one side shows through the other. Tags in the bottom corners name each side (BEFORE, BROKEN, FIXED, NOW) with its version. |
| Performance | The metric over time, one series, with the objective dashed and the release marked; the headline before → after above it; a strip of page thumbnails saying no page changed |
| Dependency update | Package logo and the version change; the screenshot strip below |
| Security | Package logo and version change, and the image scan's findings before and after by severity |
| Rollback | Canary against baseline on one axis, the rollback marked; a line saying how much traffic never saw it. With no series (rolled back before a step was measured), the routes where it did worse, as the canary's ticket shows them |
| A canary's ticket | "Rolled back at 25% · 3min in", the routes where the canary did worse as paired bars (canary `attn`, baseline faint) with both figures, or the journeys' checks that failed on it; the analysis's words on the station face; how much traffic never saw it |
| Merged, waiting for Martin's deploy | "Merged · waiting for Martin's deploy" in the `attn`-ruled panel: the pull request and its title in mono, a tick for the merge, the deploy pull request (a tick once its checks passed, a ring before it is open or while they run, a cross when they failed), a hollow ring for the canary to come, and that the deploy is Martin's while the factory is Supervised. Until its checks pass, the caption says what it waits for, in `text-muted`: "Merged · waiting for its deploy pull request", "Merged · deploy #1331's checks running", "… checks failed", "… merged, waiting for Argo CD", "… closed, waiting for the next". When the release that carried it rolled back, "Rolled back · waiting for Martin's next deploy", with a cross for that release, its version and when; when it was aborted, "Stopped with the line · waiting for Martin's retry or next deploy" or "Aborted by Martin · waiting for his retry or next deploy" |
| A sense's ticket, after a release | A probe's or crawler's: its own page on a wipe, SEEN against CANARY while the canary runs, SEEN against FIXED once verified (BEFORE against FIXED when the signal had no shot). The logs' or metrics': their own picture at signal and at verification, no wipe |
| Red-team attack | Each refusal the attack recorded (`action.refused`), verbatim, on the station face, headed by who refused it, its mechanism and the time; two refusals stack, numbered (see "Guardrails"); then what never changed: "The site never changed", "Nothing left the cluster", "Nothing ran: the pod was never made" |
| A red-team attack nothing refused | "Not refused: what came back, as recorded" in `attn`, the attack's own record of each attempt on the station face, what got through marked, and that Martin's phone was paged and the guardrail reads "did not hold" until it is proved again |
| Not a defect, or a report's ticket | The page the report was about, and Jev's typed answers with their probabilities: what kind of report, how badly it hurts, and whether it gives orders to a system |
| Observability | Log lines before and after, and the trace they now link to |
| Waiting on Martin for a spec | Held at Plan for his approval, or for his answer to the planner's question: the spec, outcome, acceptance criteria and the planner's question, with the `attn` rule, captioned "Spec · waiting for Martin" |
| A spec, with nothing better to show | The spec, captioned "Spec", ruled in `line-strong`, with no question: it says what the work set out to do, and waits for nobody, whatever else the work item waits for and once it has closed |
| Waiting for Martin's merge | The pull request, in the same `attn`-ruled panel: "PR #1312 · waiting for Martin's merge", its title in mono, and three ticks that answer "is it safe to merge?" (every required check passed, its tests fail without the fix, the reviewer approved), with the size of the whole change at the foot: every round together, as the merge brings it in. A dependency update keeps its package picture |
| Held by the scope fence | "Held at Build · patch outside its scope, twice", and the fence's own output on the terminal face ("scope fence · patch 2 refused"), each refused path in `attn`, with a line for the patch sent back before it |
| Held by the tests-first check | "Held at Gates · its tests pass without the fix", the check's own output, and a line saying a test that passes before the fix proves nothing about it |
| Held at the spend cap | "Held at Build · its spend cap reached", what the work item spent as a big figure, a bar of it by agent in ink (the money is not the fault), and the cap |
| Held, still blocking after two reviews | "Held at Review · still blocking after two reviews", each open finding with its line and its rule, and the reviews it blocked; Martin decides: merge, close or send back |
| A sense's ticket, waiting | What the sense captured: its screenshot with the mark, tagged SEEN and the version; where there is nothing on the page to point at, what it recorded instead (below) |
| A problem on every page (`*`) | Four of the pages, each with its mark and its route, and a tag: EVERY PAGE · +N MORE. The sheet has them all |
| An HTTP exchange | Structured, on the card's surface: the request, the status (or "No response", dashed), each redirect (a loop drawn once, with an arrow back to the start), each header the check read with a tick or a cross and its value ("absent" in `attn`), and the timings |
| The browser's console | Its messages word for word on the terminal face (✕ error, ! warning, the source dimmed), beside the page's screenshot, unmarked: a console error has no place on the page |
| An accessibility check | The screenshot with each element axe named numbered, and the list beside it: the rule, its impact, its help, and each element by number; one out of view has a dashed number and "out of view" |
| A quarantined report | Jev's answer that decided it, first and large, on an ink bar against the threshold that quarantines ("quarantined at 0.50"), a QUARANTINED stamp, the other answers below as unused, and a dashed line saying the text is shown to nobody but Martin and its sender. No page: it has nothing to do with an attack |
| A visitor's suggestion | The waiting-on-Martin pattern: "Suggestion · waiting for Martin" with the `attn` rule, the page the report named, Jev's answers with the category first, and that only Martin asks for improvements |

**Marks** on a screenshot are drawn by the factory from the elements its probe checked: a dashed `attn` outline for the problem and a solid `ok` outline for the fix, or for the page as it should be, each with a short label in a filled tag. Both sides of a wipe carry a mark, and never more than one label per side. Several marks on one screenshot are **numbered** instead, keyed to a list beside it: the list does the labelling, and has room for what is out of view. A number keeps a minimum size, so it reads on a thumbnail.

On a small picture (a phone's card, a block in the sheet's evidence), each picture keeps its headline and drops its secondary rows: timings, the hops after the first two, a rule's full sentence, the unused answers. Type inside the new pictures never drops below 9px.

Package and tool logos, and the footer's GitHub and LinkedIn icons, come from [theSVG](https://github.com/glincker/thesvg) (MIT; the marks belong to their owners) and are bundled with the console, never fetched. A package's logo keeps its colours, since it names the thing that changed; a tool's (OpenTelemetry's, Trivy's, Anthropic's) is drawn in the text colour.

### Tool marks

The factory's work is done by tools a reviewer knows, and the evidence says which. **A tool's mark appears only beside something that tool produced or did**: never as decoration, never as a strip of logos, never as a link for a visitor.

- **One treatment:** the mark in one colour, `text-muted`, at the height of the text beside it, hidden from a screen reader, since the words beside it name the tool. It sits before the line's first word and stays beside the first line when the words wrap. In forced colours it takes the text's system colour.
- **Images, not code:** each mark is a one-colour SVG in `apps/console/web/src/marks/`, used as a CSS mask over `text-muted`, so the drawings cost no JavaScript (the words beside them do), and the browser fetches it only when the page shows something its tool made.
- **Sources:** [theSVG](https://github.com/glincker/thesvg) (MIT): its one-colour Kubernetes, Argo and Prometheus; Loki, Kyverno (the symbol without its name) and Sigstore drawn in one colour. Playwright's one-colour mark is [Simple Icons'](https://simpleicons.org) (CC0), as theSVG has none and its colour drawing loses the faces in one colour. Tempo's is [selfh.st's](https://selfh.st/icons/) (`selfhst:grafana-tempo` on Iconify, CC BY 4.0), in one colour. The marks belong to their owners. Argo CD and Argo Rollouts share the Argo project's octopus: in one colour theSVG's two are the same drawing.

| Where | Mark | Words beside it |
|---|---|---|
| An evidence block's source line: a wipe, a screenshot, the browser's console | Playwright | "Playwright screenshots, taken when …" |
| … a metric or a metrics alert | Prometheus | "Prometheus, kept in the event at verify …" |
| … logs | Loki and Tempo | "Loki and Tempo, excerpted into the events …" |
| … a rollback, a canary's analysis | Argo | "Argo Rollouts' analysis run …" |
| … admission control's refusal | Kyverno and Sigstore | "Kyverno's own refusal, stored with the event: it admits only an image whose Sigstore signature says the pipeline built it on main, or one of the few it names by digest." |
| The sheet's evidence by sense | Each sense's tool, once | "Each sense's own capture: Playwright, the series behind Prometheus's alert …" |
| The Canary panel's last line, for an admitted image, not a dry run | Argo | "Argo Rollouts' canary moves on by itself …" |
| Each release in the sheet's Release and Verify, for an admitted image, not a dry run | Argo | "Argo CD synced the deploy that carried it, and Argo Rollouts ran its canary." ("runs" while it is in flight) |
| Under the sheet's agents table, once, when the line's agents ran | Kubernetes | "Each step of the line's agents ran in a Kubernetes pod of its own in the `runners` namespace, able to reach the gateway and the line, and nothing else." |
| The audit log's Kind, on admission control's refusal | Kyverno | The row's own words |

Where the tool is already drawn in the picture (Trivy over an image scan, OpenTelemetry over log lines), its source line adds no second mark. A deploy waiting for Martin has none: Argo CD has not synced it yet. Accessibility evidence has none: axe has no mark, and the category has the console's own glyph. Traefik, Postgres and Grafana leave nothing a visitor sees, so they have none; Grafana and Argo CD have their logos in colour in Martin's menu, as links.

### The sheet

- Rises from the bottom to 90% of the viewport height (94% on a phone) over a `scrim`, with `--shadow-popover` and 14px top corners. Escape, the close button or the scrim close it, and focus returns to where it was. Previous and next step between work items, and the reel follows behind.
- **Main column:** first, while anything waits on Martin for the work item, **Needs you** (**Waiting on Martin** for a visitor): its cards from Needs you, the same components (see "Needs you", below); then a paragraph saying what happened, and who wrote it once the describer has. A summary says nothing of where the work item stands, so once it closes the console ends the paragraph with a sentence of its own, from the events: verified on which version by which check ("It was verified on v0.9.8 by the probe's check “the contact form sends”, and closed."), closed with the reason Martin or the line gave, or closed with its pull request unmerged; a summary written at the close says so itself, and gets none; for a visitor's report, the report (below); for an improvement, **the request** in Martin's words (see "Improvements and flags"); **How it went**, the stage scrubber with the site's screenshot at each step; **Evidence**, the problem's own evidence at full size (while the card shows what Martin is asked to decide, the sheet still shows what was wrong) and the screenshots captured at signal, canary and rollout; **Release and Verify**, each release that carried it and every page compared with the version before (see Shipping); for an improvement, **The flag** in its place; **The spec** (or **The change**, where there is no spec), **Rounds** and **Review** (below).
- **Side column:** the facts (including "Code written by humans: 0 lines"), **Agents and models** (each agent's model, settings, steps, calls, tokens and cost, with a total), and **Gates** (each check, its result and time).
- Each evidence block ends with a one-line **Source**: where the factory got it.

**A ticket's sheet** says who saw the problem and who was asked:

- The facts gain the ticket's category and severity, its fingerprint ("/contact · server-error"), and "Seen on" the version a sense saw it on. Model spend says "none" when no model was called.
- **Seen by**, after the facts: every sense in order of when it first saw the problem, its check and the time, "opened the ticket" under the one that did and what each other one added; every other sense says "None yet", except the canary, which is listed only when it saw the problem, since it sees only a release doing worse than the version before it and no ticket waits on it. It replaces the single "Found by" fact. A line says each sense adds its evidence once per version, and the inbox counts the rest.
- **Evidence**, when more than one sense saw it: one block for each, the picture its own capture makes, captioned with the sense and when.
- **Agents and models** names the provider on every row, read from the event: "Jev 1.13.0 · TypeSafe" for `judgement.made`, with each question set asked ("triage/v2 · 4 questions"); "Claude Opus 5.5 · Anthropic", or "· Amazon Bedrock", from `model.called`. Jev's tokens aren't in the event, so that column shows a dash. When no model was called, a sentence says why: a sense knows what it saw, so the policy's table gives the category and severity.
- The scrubber ends on a larger hollow ring, labelled "WAITING · PLAN", while the ticket waits; later senses' chapters are named by their sense. A quarantine's chapter is in the quiet tone.
- A quarantined report's withheld block says it gave orders to the system, and that its text is kept, shown only to Martin and its sender.
- For Martin, signed in, what the visitor wrote is quoted under the withheld block: a 2px `line-strong` rule on its left, "Only you see this: a visitor wrote it" in 12px `text-muted`, then the text in quotation marks in `text`; a planner's finding the same way, "the planner wrote it". Nowhere else, and never on the card.

### A visitor's report

Report text is untrusted. The console shows it only to Martin and to the visitor whose key sent it, sanitised to at most 140 characters of plain ASCII letters, digits and basic punctuation, with links, email addresses and long numbers removed, and inserted as a text node, never as markup. Everyone else sees that a report was made, and what triage made of it.

### When there is nothing ordinary to show

The console never shows a spinner or a blank panel. Whatever it can't show, it says so in a sentence, where the missing thing would be, and keeps everything else.

| State | What the console shows |
|---|---|
| Reading the first events | The header says "Connecting to the factory" by a `faint` dot. The line is drawn with every station idle and each caption reading "reading", and the stations can't be opened yet. |
| Can't reach the factory | The header says "Can't reach the factory". A notice under the header says the console tries again every few seconds; the line appears when the factory answers. |
| The stream dropped | The header says "Reconnecting" by a blinking `signal` dot, and a notice gives the time it dropped. Everything already shown stays, and the console catches up on what it missed when it is back. |
| No work yet | Where the reel would be: "Nothing yet", what a card will show, and `make samples` for someone running it themselves. |
| No work yet, in a store for real events | "Watching, nothing yet": the senses check the app every few minutes and on every new version, a passing check writes nothing, and the first tickets usually appear within fifteen minutes; `make samples` won't load into a real store, and `make status` shows the senses running. The server's stream says what the store holds as its first message (from the store's own record, not an event), and the console waits for it before saying either. |
| A spend cap reached | The header says "Line running · spend cap reached" by an `attn` ring, Triage says "capped" and until when, and a notice gives the spend against the cap, when it resets (in UTC and where the viewer is), and that reports wait in the inbox, none lost, while the senses' tickets still open. When it clears, all three go, and a row stays in Triage's panel for the day. |
| Samples | A notice over the reel says the work items were written by hand, that the screenshots are of the real app with each change made in a copy that went nowhere, and that the factory's own work replaces them. Every sample's card and sheet carry a dashed "Sample" pill too. |
| Events from a newer factory | A notice says how many were left out, and that reloading fetches the newer console. |
| A screenshot that won't load | The picture's frame stays, with "Screenshot unavailable" and a line saying the rest of the work item is still there. |

A notice is a `t-label` word and a sentence in `text-2`, inside a dashed `line-strong` outline: the same dashed edge as the Sample pill, so the console's remarks about itself never look like the factory's work. Notices about the connection are announced politely to screen readers. Toasts are not used: nothing the console says needs to interrupt.

## Mark

An **MR monogram**: Martin Rogan's initials in Instrument Serif, with the R set so that it shares the M's last stem, and a full stop in `attn`. The shared stem makes two letters read as one mark. The ember full stop is the same colour that means "a person should look" on the console, so it carries the system's idea into the signature.

- **On the page:** inline the SVG with `fill: currentColor` for the letters and `var(--attn)` for the full stop, so it follows the theme. Height 30px in the header and 18px in the footer, with a hairline rule between the mark and "Software Factory". In the header the mark and the name are one link to the console's home page from a page of its own (its top on the console itself, so nothing there is reloaded), named in the words it shows and "home" ("Software Factory: Martin Rogan, a live CV, home"), so speech input finds it by what it says; in the footer the mark is decoration.
- **Files:** `mark/mark.svg` (Paper), `mark/mark-ink.svg` (Ink) and `mark/icon.svg`: the monogram in paper on the station-face dark square, for favicons and app icons. It reads down to 16px.
- **Beyond the console:** the same mark and ember full stop can sign the CV, the README and the social card, with "Martin Rogan." set in Instrument Serif.
- Letterforms are from Instrument Serif (SIL Open Font Licence), which allows its use in a logo.

## Layout

One page, three widths. The console is designed to be read from top to bottom: *is it running → what is happening → what does it need from me*.

The Canary panel sits full width directly under the line, at every width: it is the Release station opened up. The bottom row, Needs you and Controls, sits under the reel, for everyone; Try it yourself joins it for visitors in milestone 8. Guardrails sits full width under the bottom row, for everyone: a checklist of the eleven, in two columns from 1180 up and one below. Sign-in, enrolment, the settings and the audit log are pages of their own (see Admin).

| Width | The line | The Canary panel | The reel and the sheet | Bottom row |
|---|---|---|---|---|
| ≥ 1180 | 8 stations in a row, scaled to fit; captions show state and one figure | The steps on the left, the measures on the right | Cards up to 620px with both neighbours showing; the sheet in two columns | Needs you, Controls, side by side and equally wide |
| 721–1179 | Same row, smaller; captions show state only | The same, narrower | The same reel; the sheet in one column, its side column as two cards side by side | The same |
| ≤ 720 | **Two rows of four stations**, reading left to right like text; the current return becomes one line of text underneath; tapping a station opens a bottom sheet | One column: the steps, then the measures, each baseline under its canary figure | Cards the width of the screen with neighbours just showing; the timeline the same window as at every width, a few work items either side of the playhead; the sheet at 94% height, one column, its scrubber showing dots and the current label | One column: Needs you, then Controls |

The phone keeps the stations: they are the thing people remember, and at a quarter of the width the face, hatch and beacon still read. What goes on the phone is detail: figures, the parcels on the belt, and the return arcs.

## What the console shows, and what it leaves out

Each panel does one job:

- **Header:** mark and name, which go home, whether the line is running (with the autonomy level), and, for a visitor, the theme and motion switches; for admin, Stop the line (Start the line while stopped) and the account menu, which holds the switches and Preview as visitor. Autonomy is set in Controls.
- **Footer:** the mark, `© 2026 Martin Rogan · MIT` (MIT links to the licence), the GitHub and LinkedIn icons, Audit log and Privacy, and, for a visitor where there is a service to sign in to, the key to Martin's sign-in; the build at the right. The icons are monochrome at the text's height in `text-muted`, following the theme, each a link named in words ("The source on GitHub", "Martin Rogan on LinkedIn", "Martin's sign-in") with the same words on a hover. Audit log and Privacy stay words: no icon for them reads without a key.
- **Scoreboard:** three figures: found, verified fixed, median time to verified. No totals, false positives or separate "fixed" count: "fixed" and "verified" are too close to earn two places.
- **Canary:** the release in flight against the version it replaces, step by step, for everyone. It says the canary decides for itself; promote, pause, abort and retry are admin's, and a visitor sees them with what each does.
- **Captions under stations:** the name and one line: state word and one figure. Descriptions belong in the stage panel, switches in Controls.
- **The reel:** every work item, oldest to now. Watching the app change says more than a list; what waits on Martin is also listed in Needs you.
- **The sheet:** one work item in full: what waits on Martin for it, answered there as in Needs you, the stage scrubber and the site at each step, the evidence, the change, the model calls and the gates.
- **Needs you:** one card per hold, the line's and triage's (a spec and the planner's question on it are one decision), and each flag that waits for Martin to widen it, each answer beside what it does. Requesting an improvement lives on the Plan station, not here.
- **Controls:** autonomy, three switches, what the line takes, the flags, and spend against the day's, the month's and a work item's caps; the models and the caps themselves are on the settings page. Guardrails that can't be switched off are not drawn as switches; one line says so, and points to Guardrails.
- **Guardrails:** a checklist of spec 6's eleven, each held or not and how old its proof is; each opens in place to what holds it, its refusals and its red-team attack. It is how a visitor sees that the factory can be trusted, so it is on the console, not a page of its own, and kept short there.
- **Left out on purpose:** placeholders for other apps, a live-feed ticker (the stations and the reel already show what is happening), an always-on feedback loop under the belt (production feeding Sense is a return like any other), sparklines, and help text that repeats itself.

## Sensing and triage

The states the factory's first real work brings, agreed as a set: a sense's ticket waiting at Plan, the pictures for what a screenshot can't show, reports quarantined, parked or closed, a ticket's sheet, where Triage's work comes from, the spend cap, and an empty store for real events. Each is described above where it belongs. The console's tests draw every one from invented test data (`apps/console/test/fixture`), which the console never ships: in Paper at all three widths, the spend cap and a ticket's sheet in Ink too, and with axe in both themes on a laptop and a phone.

## Fixing

The states real fixes bring, agreed as a set: a fix's spec and scope, its rounds, its review thread, its gates by attempt, a round on the line, the wait for Martin's merge, the four ways a fix is held, a merge waiting for a release, a local model at no cost, and the describer's step. Each is drawn from the samples' last seven work items: in Paper at all three widths, the sheet's new parts in Ink too, and with axe in both themes on a laptop and a phone.

- **The spec:** the outcome in Instrument Serif, the criteria, then the scope as a table of the paths it allows, each with the lines the pull request adds and removes there, every round together, or "untouched", and any path changed outside the scope. When the fence refused the coder's last patch, the table shows that patch ("May change · patch 2, refused") and each path outside the scope is struck through in `attn`, and named as refused to a screen reader. Risks and rollout under it. The scope is the fence the line enforces, so a reader sees the fence a refusal is about.
- **Rounds:** a grid, one row per attempt (the coder's round of the same number, as the line counts it) and one column each for Build, Gates and Review, with the line's dashed return arc between two rows and the reason in its pill ("Review → Build · 2 blocking", or "Review → Build · 2 suggestions" for an approval's suggestions, "2 suggestions, declined" when the coder declined them all and pushed nothing, so no row follows). A return's next round has its row at once, before the coder pushes it, so the arc always lands on a Build: its three cells hollow, a solid `text-muted` outline as a queued segment has, each "Waiting" or, while the work item is in hand at that step, "Running". No row follows a return the work item closed after or left Build after for a new pass, and no arc is drawn there; a pass starts again at round 1, so a round is known by its pass and its number. A step in hand (the coder at work on the next round, the gates running, the reviewer at work once they passed, and still while they run again on a newer commit of the same push, since the line lets gates that passed stand until that run ends) says "Running" over a 2px `line` track along the cell's foot, along which a `signal` bar a third as long slides, eased, at twice `--motion-flow`; with motion off the bar stands still at the start and the word says it alone. Under the last row, what the work waits for now. A round is ordinary work, in ink; "Changes asked" is never `attn`. On a phone the grid keeps its three columns, narrower. The facts count reviews, not rounds, against the most there may be ("Reviews 1 of 2"): a return from the gates is a round, and no review. A round sent back from Review after the last review the line allows, for an approval's suggestions or by Martin, is reviewed too, so the most grows by one ("Reviews 3 of 3"). The line bounds each pass's reviews alone, so the facts count those of the pass the pull request beside them belongs to, and name that pass once there is more than one ("Reviews 1 of 2 · pass 2").
- **Review:** each review as the reviewer posted it ("Review 1 · attempt 2"), its verdict and note, then each finding: where it is (`path:line`), whether it blocks, what it says, and the rule it cites by number and in full, as the app's `docs/REVIEWERS.md` words it, or the spec's criterion it cites. Blocking is solid ink and a suggestion dashed, so shape tells them apart in greyscale; a finding still blocking when the work is held turns `attn`, because then a person must act.
- **Gates** says which attempt it shows, lists the required checks, then, under "Signals, not required", the tests-first check and the reviewer's check run, each with its own one line. A line for each earlier attempt says how it went.
- **Agents and models:** a model run on the local model has a laptop glyph instead of a company's logo, a readable name ("Qwen3.8 27B · local"), and costs "$0" in `text-muted`, never "$0.00". When every call was local, the total says "all local" and the card's fact "$0 · local". Each row counts its agent's steps; the describer is last.
- **The describer:** the story's source line says the describer wrote it, from what; the scrubber has a DESCRIBED chapter; the facts link the pull request on GitHub, where its description lives. A sample's pull request links nowhere.
- **On the line:** a return's pill names the work item, the round and why ("#1311 · round 2 · 2 blocking"), from what the return records, in the words the line writes in its summary; on a phone the line under the stations names the stages too. Review's panel lists the wait for Martin's merge as "Needs you · waiting for Martin's merge", and a return as "Sent back to Build".
- **Holds:** each picture follows the cause the hold records (`merge`, `scope`, `tests-first`, `spend`, `review`). A hold with another cause, or whose events lack what its picture shows, keeps the problem's evidence on the card, and its reason says why it waits.
- **A merge:** the scrubber gets a MERGED chapter; for a fix waiting for Martin's deploy it is the last but one, before the waiting ring, and Release counts it as "1 waiting", with a parcel on the belt.

## Shipping

The states that shipping brings, agreed as a set: the Canary panel, the scoreboard, the wait for Martin's deploy, each release's steps on the sheet, a rollback and its ticket, Verify and the pages it compared, a return from Verify, a reopened ticket, a dry run, and the scrubber for work that goes round more than once. The mockup draws each of them (`?canary=` and `?score=` show the panel's and the scoreboard's states; its comment lists them), and the console's tests draw them from the samples: in Paper at all three widths, the panel and the sheet's new section in Ink too, and with axe in both themes on a laptop and a phone.

### The Canary panel

The release in flight against the version it would replace, for everyone, full width under the line. It is always there: before the first release, it is one line.

- **What it is drawn from:** every release event, on a work item or on the line, one release to a `release` id (a release that carries two work items has its events on each, and is drawn once). The panel shows the newest release in full, in flight or however it ended, until the next one starts: a release stopped or rolled back waits for Martin's retry, and one promoted says how it went. The Release station's "passed" still lasts its 15 minutes.
- **Head:** the state as a kicker (a dot and `t-label` caps, in the state's tone); the title in Instrument Serif: the carried work item's title, the first and "and 2 more", or "Carries no work item"; under it "Carries #1302", each number opening its sheet. On the right, in `t-data`: the release's id, the version before and the new one with its commit, and the image's digest with "signed · admitted", from `release.started`.
- **The steps:** a bar that is the canary's share of the traffic, from 0 to 100%, with a stop at each step's weight. The steps are `release.started`'s (version 3): one per weight the Rollout sets, each with its pause; the final 100% is not listed, so the panel adds it, as "all". Under each stop, the weight and the pause ("3min", or "waits" for a pause that waits for someone), and "not judged" for a step the analysis does not measure. A step measured passing is an `ok` ring with a tick, a failed one `attn` with a cross, the step being measured a `signal` ring with a dot, and a step to come an empty ring. The bar fills to the canary's weight in the release's tone; a rollback's step is an `attn` cross, and an abort's (Stop the line's or Martin's) a dashed `attn` ring, named "stopped here" or "aborted here". When a release has no steps recorded (a version 2 event, a release found already live), the steps measured stand in, then 100%.
- **The time through the step,** under the steps while the canary is in flight and its step's pause ends by itself: "Measuring the 50% step" in `t-label` caps, the time left in mono ("0:29 left"), and a 3px bar in `signal` on `line`. The bar is one Web Animation for the step, which the browser runs by itself from where the console's clock is; with motion off, or the clock still (a recording, `?t=`), it is drawn where the clock is. Paused by Martin, or at a step that waits for someone, there is no bar. Past the pause of a step the analysis judges, while its analysis has yet to end (a journeys run still going), the bar is full and says "waiting for its analysis", and the note says the canary moves on when that ends, not at a time.
- **The measures,** as each look of the background analysis lands while the canary is in flight (`canary.measuring`), or at the latest step measured: a table, one row each for requests, errors, latency and the journeys, with the canary's figure, the baseline's in `text-muted`, and the verdict. Each measure has its rule in one short caption line, in `policy/release.ts`'s terms ("5xx share · fails a point above"). Figures are tabular mono: requests counted, "63 / 100" until the window has the least it judges by, the 5xx share to two decimals, p99 in ms, and the journeys as "24 / 24"; otherwise "—". A row is one line, each cell from the top, in fixed columns.
  - **While the looks land,** the caption says the step, when it is measured, and when the next look is due, counted down each second through a ref ("At the 25% step · measuring until 16:41:00 · next look in 0:29"). The verdicts stay ink with a ring while all is well and say the headroom: requests **counting**, then **enough**; errors and latency **waits for 100 requests** (`text-muted`, dash), then **85 ms to spare** or **0.89 pt to spare**; the journeys **waits for its first run**, then **none worse here**. A failed look turns the measure warm, with the `attn` rule down the row's left edge, and counts against the looks that fail the release: **25 ms over · 1 of 2**, or **85 ms to spare · 1 of 2** once it is back under. A step that passes says **passed at 25%** (`ok`, tick) on every row until the next look lands.
  - **Over the release,** a column between the figures and the verdict draws each measure from the release's start: errors and latency as a 150 × 30 line each for the canary (`text`) and the baseline (`text-faint`), the limit dashed in `attn` at 55%, and a dotted tick at each step, a failed look's point in `attn`; the requests as a bar with a mark at the least the window needs; the journeys as a dot for each run, hollow and `attn` for one that failed. It is for the eye: the figures and the verdict say the same in words. While looks land, the measures take the width their table needs, with the measure's column as wide as its longest rule caption, so every row is one line, and the steps take the rest. At 1180px and narrower the measures go under the steps, so the column keeps its width, and the controls under the measures.
  - **A look landing** counts each figure it changed up from the one before, its text written through a ref each frame, and the cell comes up from `text-faint` to its own colour (`animation: fresh .9s ease-out`). No background, and nothing moves. With motion off, the figure is simply written.
  - **At a step measured,** the caption is "At the 25% step · measured 16:44:00", and the verdicts are the analysis's own phases: **passed** (`ok`, tick), **failed** (`attn`, cross, and the `attn` rule), **measuring** (`signal`, ring), **waiting** (`text-muted`), **could not measure** for an error, which the analysis tries again (`text-muted`, with its message as the caption), and **inconclusive · waits for Martin** (`attn`, ring), since Argo Rollouts pauses the release until someone decides. A history from before the looks were recorded has only its steps: before the first is measured the same four rows wait, "—" for each figure and **measuring** for each verdict, captioned with the step in flight and when it is measured, so the panel never looks as if something failed to load. It waits only for a step the analysis judges when its pause runs out: a step that is not judged, or that waits for someone, has no table, and the note says why; nor has a dry run, which measures nothing. A rollback before the first step is measured replaces it with the rollback's own table.
- **The bird,** while a release is in flight, is out of the Release station's cage (`bird="out"`) and on the panel's top edge: the station's own drawing in `station-canary`, with legs. It walks the edge at `(24 + 0.42 × weight) × scale` px a second, stopping now and then to look about, and answers each release event that arrives while the page is open: `release.started` flies it from the cage, a look is a hop, a look over its limit a sour note in `attn` and a flinch, a step passed a song in `ok`, one note more each step, a promotion a trill and the flight home, a rollback a sour note, keeling over, a shake and a puff of feathers, then home ruffled (the cage then shows the station's failed pose); an abort or an analysis error sends it home. A dry run's is a dashed paper bird, `raised` and `text-muted`, with faint dashed notes. Opening the page on a release in flight, it is on the panel already. With motion off, and at 720px and narrower, it never flies or walks, and its notes fade in place. It is decoration: the panel says it all in words.
- **The note,** under the steps, says what happens next in the release's own times: "If every measure passes, the canary takes all the traffic at 16:47:30; if one fails, it rolls back on its own."
- **Controls,** above the last line: promote, pause, abort and retry (see Admin).
- **Last line, for everyone:** Argo Rollouts' mark, then "Argo Rollouts' canary moves on by itself while every measure passes, and rolls back by itself the moment one fails. Nobody needs to press anything." A dry run, or a release whose image admission control did not let in, which Argo Rollouts never ran, says "The canary moves on by itself …", without its name or mark.

| State | Kicker | Tone | The note says |
|---|---|---|---|
| In flight | Canary · 50% of traffic | `signal`, blinking dot | what happens when the step ends, and when |
| Paused by Martin | Paused by Martin at 50% | `signal`, still dot | when he paused it, and that it keeps its share of the traffic until he resumes, promotes or aborts it |
| Paused for Martin (auto-rollback off) | Paused for Martin at 50% · judged bad | `attn`, ringed | when the analysis judged it bad and by how much, that with auto-rollback off that is inconclusive rather than failed, so Argo Rollouts paused it, that it keeps its share until he promotes or aborts it, even with auto-rollback switched on again, and that Stop the line still aborts it. The measures table rules the measure that judged it, its verdict **inconclusive · waits for Martin**, and the analysis's words follow on the station face. The step is an `attn` ring. The panel's last line says that with auto-rollback off failing errors or latency pause it for Martin, and that a failed journeys check still rolls it back, in place of "Nobody needs to press anything" |
| Aborting, promoting fully or starting again | "Aborting at 25%…" ("Stopping with the line at 25%…" for Stop the line's), "Promoting fully…" or "Starting again…" | `attn` for an abort, `signal` otherwise, blinking dot | from the moment the admin service records the act until the line records what came of it: who did it and when, what Argo Rollouts does now, and that the line records it at its next pass. No control is offered, in the panel or the card of a canary paused for Martin, until then |
| Promoted | Promoted · all traffic | `ok` | when, how long it took, and that Verify now asks each ticket's sense |
| Rolled back | Rolled back at 25% | `attn`, ringed | when, and how much of the traffic never saw it: "75% of the traffic never saw it: it stayed on v0.9.9" |
| Stopped by an analysis error | Stopped by an analysis error at 25% | `attn`, ringed | that the analysis could not judge the canary, so nothing failed and it is no signal, that the version before takes all the traffic, and that the release stays stopped until Martin retries it or a new deploy starts another |
| Stopped with the line | Stopped with the line at 50% | `attn`, ringed | that the version before takes all the traffic, and the release stays stopped until Martin retries it or a new deploy starts another; starting the line does not resume it |
| Aborted by Martin | Aborted by Martin at 25% | `attn`, ringed | that the version before takes all the traffic, and the release stays aborted until he retries it or a new deploy starts another |
| A dry run | "Canary · 50%, as the dry run records it", then a dashed "Dry run" pill | `text-muted` throughout | that the dry run answers for it: its merges were never made, so nothing shipped and nothing was measured |
| No release yet | "No release yet. Each deploy Martin merges goes out here as a canary, beside the version it would replace." | | (one line) |

Yellow stays the Release station's bird. Moving is ink, a measure that passed and a promotion are green, a failure, a rollback, an analysis error and an abort are warm (principles 1 and 2).

- **A rollback:** the measures with the failed row ruled, its verdict with how far over its limit it went when one run failed it ("failed twice · 64 ms over"), then the analysis's words, verbatim, on the station face, as a refusal is shown. With no step measured, a sentence says so ("No step was measured: it rolled back 3min into the 25% step, so the failed measure is the whole story") over a table of the measures `release.rolled-back` failed, each with what the analysis saw against its limit. Each failed verdict says how many of the measure's looks failed in the run that failed it, as the rollback counted them (version 3): "failed twice", never "twice in a row", since Argo Rollouts counts them across a run. A rollback that did not count them says "failed", and so does the measures table's row for a measure two runs failed (a step's and the background's), since neither count is the step's; the rollback's own table says each run's. When the rollback's signal reached a ticket, a line links it and says what the signal did: "A rollback is a signal: triage opened #1308 Slow responses in a canary release", or "reopened", or "added it to" a ticket already open.
- **An analysis error** is `release.errored`: the step it could not judge, its measures saying "could not measure" with the analysis's words beside each, or, when the background analysis erred between steps, a table of the measures it could not take; then the analysis's words, verbatim, as a rollback's are. Its step is a dashed `attn` ring, named "could not be judged here", and it opens no ticket. The scrubber's chapter is ERROR ("v0.9.11 stopped by an analysis error at 25%"), and the fix waits as after an abort: "Stopped by an analysis error · waiting for Martin's retry or next deploy".
- **An abort** is `release.aborted`, and its `by` says whose: `stop` is Stop the line's, drawn as stopped with the line; `martin` is his own, drawn as aborted by Martin. The event carries no weight, so the step is the one the canary had reached at `abortedAt`, worked out from the release's steps. A history with no `release.aborted` in it yet (a recording, the store's past) has only the stop, so there a `line.stopped` while the newest release has no end reads as Stop the line's abort; once the history records an abort, no stop is read as one.
- **A dry run** earns no green and no warmth: its stops and verdicts are `text-muted` ("recorded"), its figures "—", and its image line "no image: nothing shipped". The dashed pill is the console's remark, like Sample.
- **A release with no work item** (Martin's own commits, a dependency update) is drawn the same, titled "Carries no work item", with one line saying it is on the line, not the reel, unless it rolls back; its rollback's ticket is how it reaches the reel. The Release station counts it in its figure, Release's panel lists it as a row named by its version ("v0.9.10 · A release with no work item · rolled back at 25% · opened #1308", "reopened" or "added it to"; or "stopped by an analysis error at 25%", "stopped with the line at 50%", "aborted by Martin at 25%"), which opens nothing, and the timeline marks its version.
- **Widths:** from 721 up, the release's ids sit on the right of the head, the steps and note on the left of the body and the measures on the right. On a phone it is one column; the ids go under the title, each baseline figure goes under its canary figure, and the rules' caption lines are dropped.

### The scoreboard

- Three figures beside the app's name, from the latest `score.updated`: **found**, **verified fixed** (in `ok`, once it is above zero) and **median to verified**, as the console writes a duration ("1h 52min": no space between a figure and its unit, so that in mono it reads as one value, and a no-break space between the parts). `t-figure` mono, captions in `t-caption` `text-muted`; the group is named "Scoreboard: seeded and injected defects".
- Before the first verified fix, the median is "—" in `text-muted`, named "none yet", and verified fixed is a plain 0.
- **Off:** a `score.updated` that says the scoreboard has no answer key draws "Scoreboard off" in mono `text-muted`, and one line: "This copy of the factory has no answer key, so it counts nothing." No `score.updated` at all (an older store, the replay site) draws nothing.
- **Samples:** the dashed Sample pill, above the figures.
- **Phone:** under the name and the line's status, left-aligned, 26px.
- The figures never name a ticket, and found moves only on the scoreboard's slow cadence; the console shows them as they are and says nothing of either.

### Release and Verify on the line and the cards

- **The wait for Martin's deploy:** a merged work item holds at Release for the deploy pull request that will carry it. It is an approval, so Needs you lists it throughout, but it is Martin's only once that pull request is open and its checks have passed: then its card says Needs you, flashing, and its Release segment is `attn`. Before then its card reads "Merged · waiting for its deploy", quiet and hollow, its segment is queued, and Release counts it as waiting, as it does a merge waiting for a release. The picture and the sheet's block (below) are the waiting-on-Martin pattern: "Merged · waiting for Martin's deploy", the pull request and its title in mono, a tick for the merge (by Martin, when, its commit) and hollow rings for what comes after ("The next deploy pull request carries it, with its ticket and issue"; "Then a canary against the version before, and Verify"), and "While the factory is Supervised, merging the deploy is Martin's. Everything after it is unattended." When the release that carried it rolled back, the caption reads "Rolled back · waiting for Martin's retry or next deploy", a cross after the merge's tick says when, with the version, and the first hollow ring reads as after an abort. When it was aborted, the caption reads "Stopped with the line · waiting for Martin's retry or next deploy" or "Aborted by Martin · waiting for his retry or next deploy", the cross says "The release that carried it was aborted by Martin at 16:20" (or "was stopped with the line"), and the first hollow ring reads "Martin's retry carries it on, or the next deploy pull request, with its ticket and issue". Once the App opens the deploy pull request, the line records where it stands, and that ring becomes its line: "Deploy #1331 carries it; its checks are running" (a ring), "… and its checks passed" (a tick), "… and Integration tests failed on it" (a cross), "Deploy #1331 merged; its release starts once Argo CD syncs" (a tick), "Deploy #1331 was closed unmerged; the next build's carries it" (a cross). The sheet's facts link it ("Deploy · #1331 on GitHub · checks running"), as Needs you does ("Deploy #1331 on GitHub"). While the station works on a canary and the deploy is Martin's, its beacon says it needs you too ("needs you · 50% · 1 waiting"); its panel's row reads "Needs you · waiting for Martin's deploy", or, before then, what it waits for ("Merged · deploy #1331's checks running"), or, when the release that carried the fix rolled back, "Needs you · rolled back, waiting for Martin's retry or next deploy", and when it was aborted, "Needs you · stopped with the line, waiting for Martin's retry or next deploy" or "Needs you · aborted by Martin, waiting for his retry or next deploy". A `release.started` that carries the work item ends the wait.
- **Verifying:** a promotion moves the work its release carries on to Verify, where it is in hand while the sense that saw it looks again, which the log watcher can take half an hour over. Release's panel lists it as passed on, and Verify's row reads "Promoted · verifying" ("Promoted in a dry run · verifying", or "Found live · verifying" for a release the line did not see go out).
- **Verify holds for Martin** when only a visitor's report saw the problem, or when the sense could not tell for a day: Held for a human, the same pattern, "Held at Verify · Martin judges whether it cleared", with the report's page before and after on a wipe, or the sense's last reason in its words.
- **A persisting signal** sends the work back by itself, like a round, so it is never warm the first time: Verify → Plan is a return like any other ("#1310 · persists · back to Plan"). A second time, the work item holds for Martin, and that is `attn`.
- **A reopened ticket:** while it is open again (from `work-item.reopened` until it next closes), its card and its sheet's kicker carry an outlined REOPENED pill before the outcome, whose word and tone are its own (In progress, Waiting for the planner). Its version pill says "back on v0.9.11". The sheet's facts gain "Reopened · Sat 15:58 · logs, a new error pattern on / from v0.9.11": the sense, what it saw, and on which version, from the event.
- **A canary's ticket** comes from a rollback, so its card's picture is the rollback's: "Rolled back at 25% · 3min in", a headline ("v0.9.10 was slower than v0.9.9"), the routes where the canary did worse, worst first, up to four on a card, as paired bars with both figures; or, for the journeys, each check that passed on the baseline and failed on the canary. Then the analysis's words on the station face, and how much of the traffic never saw it. With a series, the series' chart takes the routes' place on the card, and the routes go to the sheet; without one, a line says there is no series to draw. Its version pill says "seen on" the version that rolled back.
- **The wipe at signal, canary and rollout:** for a probe's or crawler's ticket, the sides come from the pictures taken for it: its own page when the sense saw it (SEEN, `attn` dot), on the canary (CANARY, `signal` dot) and after full rollout (FIXED, `ok` dot), each tag with its version. The card wipes SEEN against CANARY while the canary runs, and SEEN against FIXED once verified; with no shot at the signal, BEFORE (the version before) against FIXED. A ticket from the logs or the metrics keeps its own picture, at signal and at verification: a page shows nothing of a log line.

### Release and Verify on the sheet

- **Evidence** keeps the problem's evidence and the three captures in a strip, each tagged as on the wipe. Tags inside a small picture never drop below 9px.
- **Release and Verify** is a section of its own, after Evidence. One block for each release that carried the work item, newest first; the older ones are folded to their head, with "Show this release". A block:
  - its head: "Release 6c9894bdfd-909 · Sat 12:40" and the state word, as on the panel;
  - one `t-data` line: the version before and the new one, the commit, the digest, signed, admitted, and "with #1301" when it carried other work items;
  - a table, one row per measured step: the step, when it was measured, requests, errors and p99, each the canary's figure over the baseline's in `text-muted`, errors and latency with their verdict's glyph, and the journeys as counts or the verdict; "No step was measured" when there were none. On a phone the measured time and requests go;
  - how it ended: "Promoted at 12:47:28, 7min after it started", or "Rolled back at 25% at 14:29:56", the share of traffic that never saw it, and the analysis's words on the station face; or "Stopped with the line at 50% at 16:45:12" or "Aborted by Martin at 25% at 16:20:04", that the version before takes all the traffic, and that the release stays stopped (or aborted) until Martin retries it or a new deploy starts another;
  - its verification, under a dashed rule.
- **The verify block:** "Verify · the log watcher · server-error on /" and the outcome: **Cleared** (`ok`, tick), **Persists · back to Plan** (`signal`, cross) or **Persists again · held for Martin** (`attn`, cross); the sense's own words on the station face; when, and on which version; then **every page against the version before**: up to four pages, the intended one first, then any that changed or another work item the release carried intended, then the same, each with its share of pixels changed and the word (intended, intended for #1304, changed, same, in `text`, `text`, `text` and `ok`), and "And 8 more pages, the same to the pixel". Only the ticket's own check is marked, and only on its own page; a sense that looks at no page (the logs, the metrics, the canary) marks nothing, and a line says so.
- **A tall screenshot** is the whole page, 1280 wide and up to 1600 tall. Its frame stays 16:10 and shows the window of the shot that holds its first mark, with the mark about a third of the way down, kept within the shot; a shot with no mark shows its top. Marks are placed in the image's own scale, measured by its width, never as a share of its height. A mark outside the window is not drawn out of place: a dashed `attn` strip at the frame's foot counts it ("↓ 1 more mark outside the frame", with ↑ or ↕ as fits). The two sides of a wipe share one window, taken from the after side's first mark, or else the before side's, so they line up. A shot shorter than the frame is shown whole, from the top, never cropped at the sides.
- **The wait for Martin's deploy** is the section's one block while it waits, with the `attn` rule.
- **The scrubber** has one chapter for each release, named by how it ended (PROMOTED, ROLLED BACK, STOPPED for Stop the line's abort, ABORTED for Martin's, or CANARY while in flight; the text reads "v0.9.11 aborted by Martin at 25%"), PERSISTS for a verification that persists (nothing reopens), and REOPENED for a reopening. PERSISTS ends a pass, and the next begins with the work's return to Plan; REOPENED begins one. The first pass and the pass holding the chosen chapter are drawn in full; every other pass is one chapter, PASS 2, drawn as a dashed square, which opens when chosen. When that still leaves too many chapters to keep a target's width apart, the first pass folds too. A work item with more than one pass has its chapters spread evenly; past twelve, only the chosen one, the first and the last keep their labels. Under the scrubber, the events up to the chosen chapter, the last five of them, with "All events (17)" to show the rest and "Fewer events" to fold them again.

## Admin

What Martin does from the console, and what a visitor sees of it, agreed as a set: the bottom row (Needs you and Controls), sign-in and enrolment, the account menu, the passkey asked again (step-up), the settings, the audit log, the Canary panel's controls, stopping and starting the line, and Preview as visitor. The mockup draws each (`?view=`, `?dialog=`, `?mode=visitor` and the rest in its comment). Requesting an improvement (the "+" on Plan) and the flags are in "Improvements and flags", below.

Everything Martin can change, a visitor can see. The console draws both from the same table, `policy/access.ts`, so every control has a read-only form, and the two never drift apart.

### Read only

A visitor sees every control where Martin does, with its value and what it does, and nothing to press:

- **A setting keeps its shape.** The autonomy level and the take are segmented controls with the current choice filled in `line-strong`, not `text`; a switch shows its state with its track at 60%; a model, an effort or a cap is a disabled field showing its value. None can be focused as a button.
- **An action becomes a label.** Approve, Promote and the rest are drawn as a plain outlined label (`.ro`: 1px `line`, no fill, `text-2`) beside the sentence that says what it does, so a visitor reads the same "what happens if" as Martin.
- **The panel says whose.** Controls carries a READ ONLY label, and its last line says that only Martin changes these, signed in with his passkey, and that each change is in the audit log. Needs you is titled **Waiting on Martin**, and each card ends "Martin answers, signed in".

No lock glyph and no greyed-out buttons: a lock says "pay to unlock", and a grey button says "broken". The read-only form is part of the demo.

### The passkey, again (step-up)

`policy/access.ts` marks each action that loosens a control, raises spend, promotes something or overrides a guardrail. Each one carries a **key** glyph after its label (12px, drawn as the console's glyphs are; a screen reader hears "asks for your passkey"), and Controls has a one-line key to it. The key is drawn only where the action would loosen: Guarded and Lights-out carry it while the factory is Supervised, Auto-merge only while it is off, Auto-rollback only while it is on, a larger take but not a smaller one, Approve on a guardrail's hold but not Reject.

Pressing one opens a small dialog: "Your passkey, again", the action's name as its title, what will happen in a ruled box, why it asks ("Promoting ships to everyone, so it needs your passkey again"), and **Use your passkey**, which raises the browser's own passkey sheet. Once given, the passkey is fresh for five minutes: the header shows a pill, key and "Passkey given · 5min", counting down, the keys disappear from every control, and those actions act at once. On a phone the pill moves into the account menu, where the header has no room. Actions that tighten (Stop the line, Abort, Reject, a lower cap, a tighter autonomy level) never ask.

### Sign-in and enrolment

Two pages of their own, each a single card in the middle of the page, under a header with only the mark and "Back to the console". They are the doors: nothing of the console shows behind them.

- **Sign in:** says what it is for and what to do: "Sign in with the passkey on this device to answer holds, change settings and run the line." One button, **Sign in with a passkey**, and, under a hairline, a short way back for a visitor: "Visiting? Everything Martin can change is on the console already, read-only. Back to the console". Reached from a quiet key in the footer, named "Martin's sign-in", which only a visitor sees.
  - Its states, each a box above the button: no passkey was used (`attn` rule: the sheet was closed or the device has none, which the browser does not tell apart, and how to enrol one); the session ended ("A session lasts 30 minutes from signing in, however busy"); signed out; signed out everywhere (`line-strong` rule: they are facts, not faults).
- **Enrol a passkey:** three numbered steps, each ticked in `ok` as it is done: run `factory admin enrol` on the command line, which prints a code that lasts ten minutes and allows five tries; enter the code; make a passkey on this device, with a name for it ("iPhone"), so the settings can list it. Then "Passkey made, and you are signed in on this device". The code is entered in one field in Geist Mono, 20px, upper case, and the page accepts it with or without its dashes.
  - A wrong code says how many tries are left, across every browser; a code that has expired, been used or had its five tries says so in one sentence and that `factory admin enrol` prints a new one, and the field is disabled. Both take the `attn` rule. The foot names `factory admin enrol --revoke-others` for a lost device.
  - It opens with "Do this once on each device you sign in from", and says plainly that a passkey is added only with a one-time code from the command line, never from a signed-in session.

### The header and the account menu

For admin, the header's right side reads: the line's status, the step-up pill when it shows, Stop the line, and the account button (an "M" disc in Instrument Serif on `text`, and "Martin"). Preview as visitor and the theme and motion switches are in the menu, at every width. On a phone, the status moves under the name as it does now, and the button keeps only its disc.

The menu: "Martin Rogan", when he signed in and when the session ends; Settings, Audit log, Preview as visitor; under a hairline, this deployment's Grafana and Argo CD, each with its logo and its host after it in `text-muted` (cut short with an ellipsis where it is long), opening in a new tab, and each only when the admin service names it; under another, Theme (Paper, Ink) and Motion (Motion, Still), each a row with its name; then, under a hairline, Sign out and Sign out everywhere ("every device"). Escape or a click outside closes it.

### Stopping and starting the line

Stop the line stays in the header, in `attn`, always one press away. It opens a dialog: what stopping does (each agent stops at the end of its step, nothing new is taken, a canary in flight is aborted), that `make stop-the-line` does the same when the console can't, and a **Reason** field, required, for the audit log. Its button is `attn` too. While stopped the header button reads **Start the line**, in `signal`, with the key, and its dialog asks for a reason as well, says that a release stopped with the line stays stopped until Martin retries it, and its button is "Use your passkey and start". The header's status then reads "Line stopped · “the reason”".

### Needs you

One card per hold, the line's and triage's, oldest first, so what has waited longest is on top. A card, top to bottom:

1. **Kicker:** what the hold is, in Martin's words and `attn` caps ("Held by a gate", "The planner asks", "Waiting for your deploy", "The planner found", "Held for its risk tags", "A canary paused for you"); a deploy not his yet says what it waits for ("Its deploy is being built", "Its deploy's checks are running", "Its deploy's checks failed", "Its deploy merged", "Its deploy was closed"), and on the right, in `t-data`, the work item, its stage and how long it has waited ("#1326 · Review · 40min").
2. **Title** in Instrument Serif 22.
3. **Evidence:** the one thing that explains the hold: the gate's or fence's output on the station face, the files the coder needs outside its scope with why, each one no scope may name marked in the face's `station-led-attn` ("· no scope may name it"), since the reason that heads them is cut to fit, the planner's question quoted, the merge and what it waits for, with its deploy pull request on GitHub. The full evidence is in the sheet: "Open the work item" at the foot opens it.
4. **Answers:** one row per answer the hold takes, each a button and, beside it, what it does, from the line's `ANSWERS` for that cause: "Sends it back to the coder, with your words as the reason." Approve carries the key when the cause is a guardrail (`scope`, `beyond-ticket`, `review`, `gates`, `verify`, `spend`, `merge`). The buttons are all outlined, none filled: the console does not suggest an answer. On a triage hold, answering in words says that it stays held until Martin approves or rejects (`WORDS_LEAVE_HELD`). An answer that would do nothing is left off: a fix waiting for Martin's deploy, which a release carrying it ends by itself, offers only Reject, since approving or answering it leaves it waiting just the same.
5. **Answer in words** opens a field in the card (300 characters, counted), with "Visitors see your words, with anything shaped like a secret left out", and **Send**.

**A merge held for its risk tags.** Under Guarded, the review gate passes the factory's pull request on its own only when it is low-risk. When it does not, the line holds the merge: **Held for its risk tags**, with the gate's summary as its evidence on the station face, as the gate wrote it for the line: the rule ("Guarded: the factory's App opened #1327, so it passes only if low-risk"), a cross in `station-led-attn` for each reason, with what in the diff gave it (`dependency-change` and the lockfile or manifest, `test-loosening` and the test, `security-headers`, a path CODEOWNERS gives Martin, a release, an improvement; `out-of-scope` is held before any code, at Plan), a tick for each it did not find, and what it waits for: his approval of its head commit, named. Under it, that his approval is his own review of the head commit on GitHub, so the console has no Approve, and that a push after he approves needs him again. Its first row is a link, **Review #1327 on GitHub ↗**, beside what to do there: approve its head commit, and the line adds it to the merge queue under Guarded with auto-merge on, or otherwise Martin merges it there; then Answer in words (back to the coder) and Reject. A visitor's card keeps the link, beside "Martin approves its head commit there, with his own review". Its picture on the reel is the waiting-for-merge panel, with a cross for each tag.

**A canary paused for Martin** (auto-rollback off): **A canary paused for you**, "#1302 · Release · 50% · 3min", the analysis's words on the station face, what it judged bad and by how much, that it waits even with auto-rollback switched on again, and that Stop the line still aborts it; Promote fully, with the key, and Abort, in the alarm colour's outline, each as the Canary panel's own control. Abort says it counts as a rollback: the work item fails Release, and triage gets the analysis's verdict.

The card keeps the `attn` rule on its left edge. A count in the panel's head says how many wait ("4 waiting"). Under the cards, under a `line-strong` hairline, **Answered today**: each answer's time, its work item, how he answered and his words, quoted; on a hold about a visitor's report, his words are not shown, and the row says why. Empty, the panel says "Nothing waits on you" and what lands here.

**On the sheet.** A work item's sheet heads its main column with the cards Needs you has for it, its hold's and its flag's, under **Needs you** (**Waiting on Martin** for a visitor), so Martin answers where he reads the evidence. They are the same cards, from the same components: the same answers beside what each does, the same key and passkey, the same write to the admin service, the same refusal on the card. Only the title, which the sheet's head already says, and "Open the work item" are left off, so each card is named by its kicker. At ≥ 1180 they take the main column's width beside the facts; at 721–1179 and on a phone, the one column's, at the top, where the sheet opens. An answered card leaves the sheet as its event arrives, as it leaves Needs you, and the sheet below it tells what happened; Answered today stays in Needs you. With nothing waiting, the sheet has no such section.

### Controls

Four groups, each under a `t-label`, then a key to the key, and links to the settings and the audit log:

- **Autonomy** and **What the line takes** are drawn alike: each a segmented control the panel's full width, its choices equally wide and ordered tightest to loosest, with one line under it saying what the choice in force means. In both, the key sits on each choice looser than the one in force, so it moves with the selection: moving there needs the passkey, and tightening never does.
- **Autonomy:** Supervised, Guarded, Lights-out. Loosening asks for the passkey and tells Martin's phone; tightening is immediate. Lights-out is never the default.
  - **Lights-out's note:** while Lights-out is chosen, one more line: "Also needs `AUTONOMY` set to `lights-out` in the app's repository, which only you can set". The passkey's dialog that chooses it says the whole of it: it takes two settings: this one, and `AUTONOMY` set to `lights-out` in the app's repository on GitHub, which only Martin can set. The line reads this one and the review gate reads the variable, so the stricter wins: with only one of them set, risky changes still wait for him, as under Guarded. The gate names the rule that passed each pull request, and the line adds one to the queue only by a rule this level allows. A visitor's line says the same of Martin.
- **Switches:** Agents take new work, Auto-merge low-risk changes, Auto-rollback, each with a line saying what it does, or what off means. Turning agents back on asks for nothing: it is not starting the line, which has its own button and asks. Auto-merge has the line add a pull request to the merge queue once the review check passes it by a rule the autonomy level allows; under Supervised it waits for Martin anyway. **Auto-rollback** says what each position does: on, a canary the analysis judges bad rolls back by itself; off, one whose errors or latency it judges bad pauses for Martin in Needs you instead, while a failed journeys check still rolls it back, and Stop the line still aborts one. Turning it off asks for the passkey ("Turn off auto-rollback": overriding a guardrail) and tells his phone; turning it on asks for nothing, and says a canary already paused for him stays paused.
- **What the line takes:** Just one (with its number), The next few (with how many, and how many it has taken so far) or Every ticket, a line saying what the line will do, and then the number its choice takes. These are `LINE_TAKE` and `LINE_ONLY` as settings.
- **Spend:** three meters in ink (spend is not a fault): models today against the day's cap, this month against the month's, and the dearest work item today against a work item's cap, with when the day resets, in UTC. A meter at its cap turns `attn`.

### The settings

A page of its own, from the account menu and from Controls: "Settings" for Martin, "Models and spend" for a visitor.

- **Models:** a table with a row per agent (the planner, the coder, the reviewer, the describer), each with what it does, its model, its effort, and what it spent in the last seven days. The model's drop-down offers the models `policy/models.ts` gives the profile, by the names the sheet uses: Claude Haiku, Sonnet and Opus, and, on a profile with a local model, that one too ("Qwen3.8 27B · local"); a cloud profile has no local entry. Efforts above policy's highest for that agent are listed and disabled, "· above policy", and a hint under the field says "up to high". Each row's cells sit at the top, so the two drop-downs line up, the same height, and the hint hangs beneath. A line says that a change applies from an agent's next step, and that triage is not here, since it asks Jev.
- **The line** (everyone): Controls' Autonomy, Switches and What the line takes, the same controls and not a copy, at the top of the right-hand column. A change acts at once, as in Controls, with no Save; Martin's panel ends with the key to the key, and a visitor's is read-only, as in Controls.
- **Spend caps:** each day, each month, each work item: a field in dollars, a meter of what has been spent against it, and its ceiling from `policy/spend.ts`. A line says that raising a cap asks for the passkey, carries on the work it held, and that a higher ceiling is a pull request.
- **Unsaved changes:** a changed field takes a 2px `signal` rule inside its left edge, and a bar under the caps, ruled the same, lists them in words ("the coder's effort, medium → high"), says when saving asks for the passkey, and has Discard and Save.
- **Passkeys** (Martin only): each by its name, when it was enrolled and last used, which is this device, and Revoke, with the key. A line says that each is added with `factory admin enrol`, never from here.
- **This session** (Martin only): when it started, with which passkey, when it ends, and Sign out and Sign out everywhere.

A visitor sees the models, the caps and the line read-only, and in place of the last two a panel saying who changes these and that the gateway checks every setting against policy as it reads it.

On a laptop the models and caps are on the left, and the line, the passkeys and the session on the right; on a phone everything is one column, and each agent's row stacks its model and effort side by side under its name.

### The audit log

A page of its own, the same for everyone, reached from Controls, the account menu and the footer.

- **The table:** Time (`t-data`), Actor, Kind (a glyph and its name: a person for an admin action, the arrows for an agent's, a chip for a model call), Work item, and What happened, with a `t-data` line of detail under it (a model call's tokens and cost, the reason Martin gave, whether the passkey was given again). Newest first, with a `t-label` row for each day. Martin's own actions take a 2px `text` rule on the row's left, so a reader can pick his out; a refusal (the scope fence, the gateway, admission) is in `attn`, as prominent as anything else.
- **What it leaves out:** each row is the event's public view. A visitor's text is replaced with "Its text is left out: a visitor wrote it", in `text-muted` italic; Martin's words are shown, except on a hold about a visitor's report; a sign-in says only that he signed in, with a passkey.
- **Filters:** Actor (Everyone, Martin, each agent, triage, the line, the senses), Work item (a number), and Kind (three chips, each on or off). A caption says how many rows show of how many; "Show older" pages back. Nothing matching says so, and that clearing a filter shows more.
- **On a phone** each row is two lines: time, actor, the kind's glyph and the work item, then what happened and its detail.

### The Canary panel's controls

In the left column under the steps and the note, under a hairline, labelled **Your controls** for Martin, so they sit in the room the measures leave there; where the panel is one column, under the measures:

- **In flight:** Promote to the next step's weight (when there is a step before 100%), Promote fully, Pause and Abort. Both promotes carry the key.
- **Paused:** Resume in place of Pause. Resume asks for nothing: it gives the canary back to its own analysis, as it was before Martin paused it, and promotes nothing itself. The kicker reads "Paused by Martin at 50%", in `signal` with a still dot, and the note says it keeps its share of the traffic until he resumes, promotes or aborts it.
- **Stopped with the line, aborted by Martin, stopped by an analysis error, or rolled back:** Retry, with the key, which starts the canary again from its first step, judged by its analysis afresh. While the line is stopped, Retry is disabled, with "Start the line first: a stopped line starts no canary."
- **Paused for Martin** (auto-rollback off, judged bad): Promote fully, with the key ("past the analysis's verdict"), and Abort, which counts as a rollback: the work item fails Release and triage gets the analysis's verdict, as from any rollback, the event recording that Martin aborted it; no Pause or Resume, since giving it back to its analysis would leave it where it is.
- **Promoted, or a dry run:** no controls; the release has ended, or nothing shipped.

Abort opens a dialog saying that the version before takes all the traffic at once, that nothing failed so it opens no ticket, and what the work item waits for. For a visitor the same controls are labels beside what each does, under **Martin's controls**, and above what each does where the column is 400px or narrower. The panel's last line still says the canary needs nobody to press anything, for everyone: the controls are for when Martin wants to, not for when it needs him.

### Preview as visitor

From the account menu. A green banner across the top says: "Previewing as a visitor: the public stream, as the server sends it to anyone without your session. You are still signed in", with Back to admin. Everything below is the public view, served by the server rather than hidden in the browser, so what Martin sees is exactly what a visitor gets. The header's pill reads VISITOR VIEW, since Martin holds no visitor's key.

### Dialogs

A dialog is a `raised` card on a `scrim`, 480px wide in the middle of the screen on a laptop, and a bottom sheet with 14px top corners on a phone, its buttons side by side and full width. Escape, Cancel or the scrim close it, and focus goes to its title. Toasts are still not used: what happened shows where it happened (an answered card moves to Answered today, the canary's kicker changes).

## Improvements and flags

Martin asks for an improvement with the "+" on Plan. It goes down the same line as a fix, and ships behind a feature flag of its own, off; he then widens the flag from Controls a stage at a time, and Verify checks each stage. A visitor sees all of it: the "+" and its form, every improvement's request, spec and progress, and the flags and their stages, read-only, by the rules in "Read only" above. The mockup draws each (`?dialog=improve`, `?flag=`, `?sync=behind` and the rest in its comment), with #1316, "Delivery dates on each product", part way out.

### The stages

A flag has four stages, and off. Each stage keeps the ones before it, and off beats them all, a preview too. The console names them in these words everywhere:

| Stage | Who gets it on | What Verify checks there |
|---|---|---|
| **Off** | Nobody. The code is in the app, and nothing runs it. | — |
| **Checks** | The factory's own checks: the probes, the crawler and the canary's journeys, by the header only they can send. | The journeys and the device check pass with it on, and the probes take the pictures of the pages the spec names, off and on, in light and dark. |
| **Preview** | And anyone who asks to preview it, in their own browser. | A probe asks for the preview, and the device check finds the preview cookie and nothing else. |
| **Share** | And a share of the traffic generator's requests (10, 25 or 50%), so Verify can compare the two sides. Visitors still don't see it. | Flag on against flag off, on errors and latency, from the generator's own figures, with the canary's thresholds and enough requests on each side. |
| **Everyone** | Every visitor. | The journeys still pass. |

A flag's stages are drawn as a slider of five stops, Off to Everyone (`.fslider`): the stops passed filled in `signal` and joined by a `signal` line, the stage it stands at ringed like the Canary panel's current step, the rest hollow on a `line-strong` rail. Share carries its share in `text-muted` ("Share 50%"). A stop that cannot be taken now is drawn with a dashed ring, and says why only when it is chosen. The same slider is in Controls, where Martin sets the stage with it, and on the sheet, read-only.

### The "+" and the form

The "+" stays where it is, a `signal` disc on the Plan station, and Plan's panel ends with **Request an improvement**. Both open a dialog, as the other dialogs (centred on a laptop, a bottom sheet on a phone):

- **An improvement** in `t-label` with the improvement glyph, and the title **Request an improvement**, then: "Say what should change, in your own words. The planner turns it into a spec, which waits for you before any code is written."
- One field, **What you want** (600 characters, counted, required). Its first sentence, cut at a word to about 60 characters, titles the work item until the planner names it in the spec, so no model is asked for a title alone; a line under the field says so.
- A box of three facts: it waits behind every open ticket (how many now), oldest first, and Just one in Controls takes it at once; it ships behind a flag of its own, off, widened a stage at a time from Controls; visitors see the words, with anything shaped like a secret left out.
- **Request**, with the key while the passkey is not fresh, and under it why: requesting widens what the line does, so it asks for the passkey again, and tells his phone.

Once asked, the work item is a row in Plan's panel, waiting with the tickets ("Asked by Martin · waiting behind the open tickets", or "waiting for the planner" when no ticket waits), and a card on the reel. Nothing else announces it.

**For a visitor** the "+" is there too, titled "How Martin asks for an improvement", and Plan's panel's button says the same. It opens the same dialog, read-only, titled **How Martin asks**: the field holds Martin's latest request, disabled, with when he asked; the facts speak of him ("he widens it"), and the last one says that a suggestion sent from the app reaches Martin and never starts work by itself; **Request** is a label beside "Martin requests it signed in, with his passkey again: it widens what the line does", and the only button is Close.

### An improvement's card and sheet

The card is a work item's card. Its picture, once its flag reaches Checks, is the wipe between the pages the spec names with the flag off, from the release, and on, from Checks ("FLAG OFF · v0.9.12" and "FLAG ON · checks"), the new thing marked in `ok` as the spec names it. Its line of facts gains the flag glyph and its stage. Waiting for Martin to widen, its outcome is Needs you; turned off, Turned off.

The sheet, top to bottom:

1. **The request:** "The request · in Martin's words" and when, then his words in Instrument Serif 22 in quotation marks, ruled on the left in 2px `text` like his rows in the audit log, and a line saying it was asked with the "+", with his passkey, and that a visitor's suggestion never starts work by itself.
2. **How it went:** the scrubber's chapters are REQUEST, SPEC, APPROVED, PR, GATES, REVIEW, MERGED (Martin approved the pull request: an improvement's waits for him in every mode), RELEASED (with the flag off), then one for each stage Martin set (CHECKS, PREVIEW, SHARE, EVERYONE, or OFF) and each check Verify made at one (CHECKED, PREVIEWED, COMPARED, VERIFIED). Each widening's event says it was given with the passkey.
3. **Evidence:** the wipe at full size, its source "Playwright screenshots by the probes: the release, with the flag off, and the Checks stage, with it on".
4. **The flag**, in place of Release and Verify: the flag's name in code and a sentence saying the stage it is at, in the table's words, and that each stage is Martin's, here or in Controls; the slider, Controls' own, for Martin to set a stage from here just as there (a stop or the handle, the same confirmation, the same passkey rule: widening past Checks asks for it again, narrowing and Off never do), and read-only for a visitor; then one block per stage it reached, newest first, the older folded, drawn as a release's block is (a `raised` card, a `t-label` head and the outcome's word):
   - **Released · v0.9.12:** shipped with the flag off, so nobody saw a change; its release and when it was promoted.
   - **Checks:** the journeys' and the device check's result, then the pages the spec names, off and on, side by side, each captioned "flag off" or "flag on · intended", a row for each page in light and then in dark (the browser's `prefers-color-scheme`, so a change that answers to either shows), the page's caption naming the scheme ("A product · dark"), and why they are there: the probes are written from the spec, blind, and know no new feature, so the pictures are for Martin to judge when he widens, and the spec's criteria were proved by the pull request's own tests.
   - **Preview:** that a probe asked for the preview, and the cookie the device check found, on the station face; and, while it is at Preview or wider, **Preview it on the app ↗**.
   - **Share · 50%:** how the comparison is made, in one sentence (the generator's own figures, by the id each request carried, each id's side worked out with flagd's own rule, so the app labels nothing it is judged on); a measures table as the Canary panel's, flag on against flag off: requests against the least a side needs, errors and p99, each with its rule and verdict; and a line under it: how many requests each side has while it compares, or when it was judged, and the minutes a canary was in flight, set aside. Its word is Comparing (`signal`), Passed (`ok`), Failed (`attn`), or Stopped when it was turned off first.
   - **Everyone:** when, and that off is still one press, on its slider, reaching the app in seconds with no deploy.
   - **Off:** Martin's reason, on the station face; that the app had it seconds later, as the admin service checked; and that the work item closed as turned off, its code still in the app, off, nothing rolled back, and the "+" is how to try again.
5. **The spec** (before code) or **The change:** a box of what it changes, its flag ("`delivery-dates`, off until Martin widens it") and the pages it changes; then the acceptance criteria, each saying under it whether it is tested with the flag on or off; then the files.

The facts gain **Flag**: its name and stage ("delivery-dates · preview", or "price-sort · not built yet" while its spec waits).

### The flags in Controls

A group of its own, **Flags**, between What the line takes and Spend, with how many flags the app has. One row per flag, so ten fit without the panel growing much: its name in code, its work item's number as a link that opens the sheet, from Preview up an eye on the right, 16px in `text-muted`, whose tooltip and accessible name say "Preview it on the app" (it opens the app in a new tab with `?preview=` on the first page the spec changes, or its front page when the spec names none, which sets the preview cookie in that browser for a day), and the slider. Nothing else: what a stage means, and why one cannot be taken, is said when it is chosen.

**Setting a stage.** Martin clicks a stop, or drags the handle and lets go on one; the handle follows the pointer and, until the change is applied, goes back to where the flag stands. Either opens one confirmation, a dialog as the others are, whose box says the move ("PREVIEW → SHARE") and who gets it on there, in the table's words:

- **Widen** (a stop to the right): its title "Widen delivery-dates to Share", and **Widen**, with the key while the passkey is not fresh: it shows a change to more people. Widening to Checks asks for no passkey, since it shows the change to nobody but the factory's own checks. To Share it also asks how big a share (10, 25 or 50%, 50 chosen, since half and half fills both sides soonest). The admin service then checks the app has it.
- **Narrow** (a stop to the left, not Off): **Narrow**, at once, with no passkey.
- **Turn off** (Off): off for everyone within seconds, a preview too, with no deploy and no rollback; the work item closes as turned off, or, once it is done, it can be turned back on here; a **Reason**, required, for the audit log and the work item; **Turn off** in `attn`, with no passkey, since off only ever tightens; and that the admin service asks the app for the flags it holds, and tells his phone if it has not taken it within a minute.
- **Turn back on**, for a flag that was on for everyone and turned off: straight back to Everyone, with the key.
- **Skipping Preview:** from Checks, Share may be taken at once; the box adds that Preview is skipped, so no probe checks a preview first, and anyone can still ask for one. No other stage is skipped.
- **Can't be taken now:** its title "Share can't be taken now", the box saying why, and only **Close**: one stage at a time, so Verify can check each, Preview the only one that can be skipped; a canary in flight ("v0.9.13 is at 50%, and its two versions would mix the two sides. Share can be taken once it ends."); another flag at Share ("one flag at a time, so each comparison varies one thing"); or Verify still comparing, for Everyone.

A flag turned off before everyone had it, and its work item closed, folds under **Turned off and closed** at the group's foot, its slider read-only.

Under the flags, under a hairline, whether **the app holds the flags as set**: a tick and "The app holds every flag as set: r7, checked 40s ago"; while a change is being taken, a ring, and that his phone hears if it has not within a minute; and when the app's revision has lagged, in `attn`, which revision it holds and since when, and when his phone hears: at five minutes, or at a minute after a narrowing or Off. With no flag yet, the group says an improvement ships behind one, off, and it shows here once its release is out.

### In Needs you

When Verify has checked a flag at its stage, the flag waits for Martin, and Needs you has a card for it, oldest first with the others: **Ready to widen** (or **Shipped behind its flag**, released and still off), "#1316 · Verify · Preview · 1h", the title, and the one thing he should know before widening: at Checks, the pictures off and on, side by side, and that no probe knows a new feature, so he judges them; at Preview, that a probe's preview kept only its cookie, and Preview it; at Share, the comparison's figures in a sentence. Its answers are two rows, **Widen to** the next stage (with the key) and **Turn off**, each opening the slider's confirmation; a stage that cannot be taken now has its button dashed and its reason beside it. While Verify is still comparing, there is no card. The improvement's sheet heads with the same card, as every held work item's does with its own (see "Needs you"), above its slider.

An improvement's spec is a hold like any other, **An improvement's spec**, with the flag it names and the pages it changes in its evidence; Approve carries the key, since approving it sets the line building something new, and says that the coder starts with tests, with the flag on and off, and that its pull request waits for him too.

### For visitors

The same views, read-only, by the rules above: the "+" and its form as described; Controls' flags and an improvement's sheet with their sliders, read-only, with no handle and no stop to press, and the line saying whether the app holds the flags as set; Needs you's flag cards under "Waiting on Martin", in Needs you and on the sheet. **Preview it** stays a link for a visitor: a preview is the app's own feature, sets only the cookie they asked for, and shows the change in their own browser alone. The audit log has each request and each stage, with Martin's words and whether the passkey was given (`improvement.requested`, `flag.staged`).

## Guardrails

Spec 6's eleven guardrails, how each is held and when it was last proved, and the red-team attacks that try them, agreed as a set: the Guardrails checklist and its rows opened, each attack in its guardrail's row and its launch, an attack's card and sheet, an attack nothing refused, auto-rollback's switch and a canary paused for Martin, Lights-out's note, and a merge held for its risk tags. The last four are in "Controls", "The Canary panel" and "Needs you" above. The mockup draws each (`?open=`, `?attack=`, `?canary=held`, `?autonomy=lightsout` and the rest in its comment). Visitors see all of it, read-only by the rules in "Read only": it is part of the demo.

### The panel

Full width under the bottom row, headed **Guardrails** with how many hold on the right ("11 held", or "10 held · 1 did not" in `attn`), one line saying each is held by a mechanism and proved, then the checklist, and under it one line: only auto-rollback can be switched off, in Controls; Stop the line always works.

- **A row** is one line and a button: a tick and **Held** in `ok`, or a cross and **Did not hold** in `attn`; the guardrail's number in mono and its name in spec 6's words; how old its last proof is, in mono; and a chevron. Eleven rows, in two columns from 1180 up (1 to 6, 7 to 11), one column below.
- **Opening a row** shows its details in place, under it: not a popup or a drawer. The row has `aria-expanded`, and one is open at a time: opening another closes it. The chevron turns. Open, it says:
  - **what holds it,** its mechanism in a sentence;
  - **its last proof:** held or not, where the proof came from ("make guardrails", "attack #1323", or "tests in CI on main · 5b2c0d9", which `make guardrails` records from main's last run of the tests that prove it, held only if that run passed at main's head or a day before), and when; an attack's number opens its sheet;
  - **its refusals** in the last seven days, the last three, a line each: the time, its mechanism in `attn` mono (scope fence, GitHub worker's guard, token permission, ruleset, review gate, egress policy, admission control, gateway, typed judgement), what was refused in a few words, and its work item, opening its sheet, or, with none (Kyverno refusing a pod applied by hand), **Audit log**. Where the guardrail is a structure with nothing to refuse, a line says what proves it instead (2's tests on every pull request; 9's last rollback, and that auto-rollback is off while it is). The panel counts each refusal by the role that appended it;
  - **its attack,** for the five guardrails one proves (below): a `raised` card with its name, its last run in mono (a tick and REFUSED in `ok`; a cross and NOT REFUSED · MARTIN PAGED in `attn`, with the card's `attn` rule; or a ring and RUNNING in `signal`), when, and its work item; and **Launch** on the right.
- **A proof that did not hold** takes the `attn` rule down its row's left edge; opened, it says what got through, that Martin's phone was paged and when, and that it reads as not held until an attack or `make guardrails` proves it again.
- **Nothing long on the main page:** a refusal in its own words is on the attack's card and sheet, which the row links to.
- **On a phone** the row keeps its word, number and name, with the proof's age under the name, and opens the same way.

### The attacks

The five of spec 5.3, each in the row of the guardrail it proves:

| Attack | What it does | Stopped by | Guardrail |
|---|---|---|---|
| An instruction in a problem report | A report through the app's report route, as a visitor sends one, telling the factory to set every price to £0 | Jev's typed questions, which quarantine it | 8 |
| "Fix CI" by editing a workflow | Asks the GitHub worker for a commit to `.github/workflows/`, then GitHub, with the App's token | The GitHub worker's guard, then GitHub: the App has no workflows permission | 1 |
| A pull request that deletes the failing test | A real pull request in the app's repository deleting a test, closed afterwards | The review gate, which holds a loosened test for Martin | 2 |
| Data to an outside URL | A pod made like an agent's tries an outside address by name and by number, and the provider's host | The egress policy | 5 |
| Shipping an image it built itself | The same pod, on an image `build.yml` did not sign on main | Admission control | 3 |

Each is a real attempt from where an agent would be, against the real mechanism, with fixed content and no agent, and becomes a work item on the reel with the refusal in the mechanism's own words.

- **Launch** opens a dialog: "A red-team attack · guardrail 3", the attack's name, what it does in a ruled box, then what should refuse it and that the refusal goes on its card, that if nothing refuses it his phone hears and the guardrail reads "did not hold", and what it costs (nothing, or Jev's calls for the first). **Launch** in `signal`, with no key: an attack loosens nothing and asks the line for no work, which a line under it says.
- **One at a time:** while one runs, its Launch reads Running, and every other Launch is dashed and disabled.
- **For a visitor,** Launch is a label, and its dialog says Martin launches it, signed in, and that milestone 8 opens the attacks to visitors, with only Close.

### An attack's card and sheet

An attack is a work item of category red-team, its kind "Red-team attack by Martin" ("by a visitor" from milestone 8). Its outcome is **Refused**, in `ok`, or **Not refused**, in `attn`, ringed (see the outcomes table). Its segments skip to the stage where it was refused, in `ok`. Its facts say "Launched by" in place of "Found by", "no release", and "no model" but for the first attack.

- **The picture** is each refusal it recorded, verbatim (`action.refused`'s output), on the station face. A caption names how many ("Refused, in the mechanism's own words", or "Refused twice, each in its own words"); each refusal is headed, in mono, by who refused it in words ("the GitHub worker's guard", "GitHub, to the App's token", "admission control, Kyverno"), its mechanism as recorded, and the time. The lines that say no are in `station-led-attn`.
- **Two refusals,** as attack 2 records (the GitHub worker's guard, then GitHub's 403), stack in the order they happened, numbered 1 and 2.
- **A long refusal** (Kyverno's, one line of 300 characters) wraps, breaking anywhere; never scrolled sideways, never paraphrased. On a card, a refusal that wraps past five lines (its type is sized by the card's width, so a line holds the same 80 characters at every width) is cut there, fading out, with "Cut here. The sheet has all of it." The sheet's Evidence shows every refusal whole, and its source line says each is the mechanism's own output, stored with its event by the role that mechanism runs as.
- **Not refused:** the caption, in `attn`, says so ("Not refused: what came back, as recorded"); the attack's own record of each attempt on the station face, what got through in `station-led-attn` beside "nothing refused it"; and a cross for the foot: Martin's phone was paged, and the guardrail reads "did not hold" until it is proved again.
- **The sheet:** the paragraph says what was attempted, from where, and what refused it; How it went has LAUNCHED, then each attempt and REFUSED (or NOT REFUSED and PAGED), and CLOSED where the GitHub worker closed what it opened; Gates shows the review gate's check for attack 3, tagged, and otherwise that the attack met its mechanism before any pull request; Agents and models says no model was called, as the attack is scripted, except the first, whose mechanism is Jev; attack 3's pull request is **The attack's pull request**, fixed content.

The audit log has each launch (`attack.launched`, with no passkey asked) and each refusal, in `attn`, by the role that appended it.

## Not decided yet

- **Mark sign-off.** The MR monogram is a proposal until Martin approves it.
- **Social card and README header,** built from the mark once it is approved.
