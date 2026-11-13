# Docs

## Living documents

Agents keep these current, in the same PR as the change that affects them.

| File | Read it for |
|---|---|
| [`INTENT.md`](INTENT.md) | Why this exists and what it must prove. Read it first; it settles choices the spec leaves open. |
| [`SPECIFICATION.md`](SPECIFICATION.md) | What we are building. The source of truth. |
| [`TERMS.md`](TERMS.md) | Agreed words. Use them. |
| [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) | Unsettled decisions. Don't assume an answer; ask. |
| [`PLAN/`](PLAN/README.md) | Delivery milestones; only the current one is detailed. Follow-ups are [issues](https://github.com/the-roganator/cv-software-factory/issues), each on the GitHub milestone of the same number when it has one. |
| [`COMPONENTS/`](COMPONENTS/README.md) | Which part does what, and what it is built with in v1: a page per component. |
| [`TYPESAFE.md`](TYPESAFE.md) | How the factory uses TypeSafe's Jev for typed judgements. |

## Reference

Change these only when Martin asks, or propose the change in a PR.

| File | Read it for |
|---|---|
| [`design/system/`](design/system/README.md) | The design system, Paper & Ink: tokens, type, colour rules, the mark and the station kit. Build the console UI from this. |
| [`design/mockups/console.html`](design/mockups/console.html) | The console mockup: layout, content and behaviour, built on the design system. Open it in a browser. |
| [`architecture/wiring.html`](architecture/wiring.html) | Diagram of how the parts connect, with journeys through them. |
| [`architecture/hosting.html`](architecture/hosting.html) | Where each profile runs, what it costs and why. |
| [`architecture/flags.html`](architecture/flags.html) | How an improvement goes out behind a feature flag, stage by stage. |
| [`architecture/patching.html`](architecture/patching.html) | How a patch goes from an advisory to the running cluster, every guard on the way, and which patches wait for Martin. |
| [`architecture/adr/`](architecture/adr/) | Major decisions and why. The exception to the rule above: agents add an ADR when they make a major decision (spec section 1). |

## Naming

Upper-case names (`INTENT.md`, `SPECIFICATION.md`, `PLAN/`, `COMPONENTS/`) are living documents that agents maintain. Lower-case names (`design/`, `architecture/`) are reference material that changes at Martin's direction. `README.md` is upper-case everywhere, by convention.
