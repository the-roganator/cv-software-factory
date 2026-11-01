# Delivery plan

The plan is a sequence of milestones. Each one ends with something demonstrable, and the next one does not start until the current one's exit criteria are met.

Only the current milestone is detailed, because each one is likely to change the next. When a milestone starts, it gets its own file here with tasks and exit criteria; until then it is a line in the table below.

## Starting and finishing a milestone

**Starting:** write its file, and take whatever fits from its [GitHub milestone](https://github.com/the-roganator/cv-software-factory/milestones)'s issues, issues with no milestone, and the [open questions](../OPEN-QUESTIONS.md) into it.

A done-when that needs an event the factory does not control, such as a release while a flag is at a stage, names the drill that makes the event, so its proof does not wait on a coincidence.

**Finishing:** end its file with a retrospective of what was learned, and give each lesson a home. A milestone built in parts ends each part with its own retrospective, in that part's last task, and the milestone's at the end:

- a major decision becomes an ADR;
- something that is now simply true goes in the spec, `COMPONENTS/` or `AGENTS.md`;
- a decision that needs Martin goes in the open questions;
- anything else worth keeping becomes an [issue](https://github.com/the-roganator/cv-software-factory/issues), on the milestone it waits for if it has one.

Then update the table below.

| # | Milestone | Outcome | Status |
|---|---|---|---|
| 1 | [Foundations](M01-FOUNDATIONS.md) | Public `cv-software-factory` repo with exemplary hygiene; `make up` runs a local Kubernetes cluster with GitOps and telemetry, deploying a console skeleton built by CI | Done |
| 2 | [The World's Worst Website](M02-WORLDS-WORST-WEBSITE.md) | App with ≥ 20 seeded defects, OpenTelemetry, report widget; answer key with fingerprints in `cv-software-factory-private`; published as `cv-worlds-worst-website` from one clean first commit; deployed locally by Argo CD | Done |
| 3 | [Event store and console](M03-EVENT-STORE-AND-CONSOLE.md) | Event schema with versioning; the console, in React and Vite, renders the line, the reel and the sheet from hand-written sample events, screenshots and model calls included; live updates over server-sent events | Done |
| 4 | [Sensing and triage](M04-SENSING-AND-TRIAGE.md) | Probes, crawler, telemetry alerts and reports produce deduplicated tickets with evidence and screenshots; triage runs on a Jev question set with an evaluation fixture set; gateway with record and replay from the first model call | Done |
| 5 | [Fixing](M05-FIXING.md) | GitHub App, agent runners, planner, coder and reviewer; code-owner review required on `main`; the App opens the deploy and release pull requests, so workflows lose the right to open (and approve) them; CI gates in `cv-worlds-worst-website`; one seeded defect fixed and merged with no human code, at Supervised autonomy | Done |
| 6 | [Shipping safely](M06-SHIPPING-SAFELY.md) | Signed images, admission control, canary with traffic generator, verification, ticket close or reopen, scoreboard; a bad change is rolled back automatically | Done |
| 7 | [Admin and guardrails](M07-ADMIN-AND-GUARDRAILS.md) | Admin mode signed in with a passkey, every control visible read-only to visitors, alerts to Martin; improvements requested with the "+" and shipped behind feature flags; every guardrail proved from one command, the red-team harness, and Guarded autonomy by deterministic risk tags; everything scanned every day with a deadline for each finding, the app patched down the line | In progress |
| 8 | Visitor features | Visitor access keys and their usage view; inject a defect from a menu within the 20-minute target; the red-team menu over the harness; the report widget through triage; visitor limits and budget | |
| 9 | Replay site | First public deliverable: curated recordings on GitHub Pages, README with GIF, `make demo` running on cassettes | |
| 10 | Live on DigitalOcean | Terraform, Cloudflare Tunnel, running Guarded, an outside uptime check and a dead man's switch, with `cloudflared`'s tunnel metrics alerted on by a rule and the public URLs added to the probes' addresses, reset to baseline | |
| 11 | Interview on AWS | Terraform for EKS, Bedrock adapter, weekly apply, smoke-test and destroy job; recorded walkthrough | |
