# Software Factory: specification

**Owner:** Martin · **Implementer:** coding agents, with Martin as product owner

## 1. Purpose

Software Factory is a working system of AI agents and deterministic gates that looks after a live web app. It notices problems, writes fixes, proves they are safe, ships them as canaries and checks they worked. It also ships small improvements Martin requests, through the same line.

It is Martin Rogan's portfolio piece; why it exists and what it must prove are in `INTENT.md`. Every page of the console and replay site carries "Software Factory · Martin Rogan" in its title. The bar:

- **It really works.** Real defects are detected, fixed, gated, canaried and verified with no human writing code.
- **It explains itself.** A recruiter gets it in one minute; an engineer can go deep without reading the code first.
- **It is safe by mechanism.** The guardrails (section 6) are the point. A reviewer should leave thinking "this person knows how to let AI loose safely".
- **It is cheap and easy to switch off.** Hard spend caps, one command to stop everything.

### Working rules for the implementer

1. This spec describes the current intent only. Keep it current in the same PR as any change; do not add history.
2. Record only **major** decisions as ADRs in `docs/architecture/adr/`: short, and only where the reasoning is not obvious from the spec.
3. Items marked *(default)* may be replaced if the replacement is noted in the PR. Everything else needs Martin's agreement to change.
4. Ask before anything expensive to reverse: spending money, creating cloud accounts, making something public.
5. Every commit, PR, issue and ADR is public and part of the demo. Write for a thoughtful reviewer.

Terms are defined in `TERMS.md`; unresolved questions live in `OPEN-QUESTIONS.md`. The console is built from the design system in `design/system/`; `design/mockups/console.html` sets its direction. `COMPONENTS/` maps the spec onto concrete parts; where they conflict, this spec wins.

## 2. Audiences and how they experience it

| Audience | Time | Experience |
|---|---|---|
| Recruiter | 1 minute | Static replay site: the shop's recent history on the landing page, to step through change by change |
| Engineer / future colleague | 10–30 minutes | Live instance: inject a defect, red-team the factory, open any work item and step through it. Or clone and run `make demo` |
| Interviewer | An hour | A fresh AWS environment stood up on demand, walked through live |

Public forms, in delivery order:

1. **Replay site** on GitHub Pages: the console built statically with curated recorded work items. No backend, no API key, nothing to go down. The first public deliverable.
2. **Live instance** on DigitalOcean: always on, visitor access keys, visitor actions enabled.
3. **Interview instance** on AWS: created with Terraform on demand and destroyed afterwards. Always starts from the seeded baseline.

Development happens on Martin's laptop first (section 8).

## 3. The app: "The World's Worst Website"

A deliberately bad, funny, small web app that gives the factory real work.

- A few pages and at least one backend API: home, product list, product detail, search, about, contact form.
- A **"Report a problem"** widget on every page. A report is one structured log record: the app holds no credential and does not know the factory exists. Report text is untrusted and is never shown back on any page.
- Instrumented with **OpenTelemetry**: traces, metrics (rate, errors, latency per route) and structured logs. Health and version endpoints, so canary and baseline can be told apart.
- Runs as a container; two versions can run side by side.
- No real user data, no secrets, safe to expose publicly. The catalogue is a SQLite database built into the image and opened read-only, so the app needs no other service.
- TypeScript on Node *(default)*.
- It is an earnest bad shop, not an ugly one: the comedy is in the copy, and the pages are tidy enough that a defect stands out as a defect.

### 3.1 Seeded defects

- At least 20 defects across at least six categories, easy and hard. Favour defects that are **visible** on screen, because they make the best demo.
  - **Content:** typos, wrong dates, lorem ipsum, inconsistent product names
  - **Navigation:** 404 links, broken images, redirect loops
  - **Functional:** search ignoring the query, valid emails rejected, off-by-one pagination, negative prices
  - **Errors:** a 500 on a specific input, unhandled rejections, browser console errors
  - **Performance:** a slow endpoint, an N+1 query, a 5 MB hero image
  - **Accessibility:** missing alt text, poor contrast, unlabelled fields
  - **Security hygiene:** missing security headers, verbose error pages. Benign only; no vulnerable dependencies.
  - **Observability:** a route that logs nothing, a metric with a wrong label
- Every defect is fixable alone, benign, and out of the way of the line: none touches the health or version endpoints, the report endpoint or start-up, or stops telemetry leaving the pod.
- The app's public history starts from a clean first commit already containing the defects. No names, comments, tests or TODOs hint at them, and no public repository lists them.
- The app is written correctly in the private repository, and each defect is a patch kept beside it. The first commit is the correct app with every patch applied (ADR 0006).
- A **reset** restores the app to the seeded baseline through a normal PR.

### 3.2 Answer key and scoreboard

- The **answer key** lists every seeded and injectable defect with category, difficulty, location, symptom, a **fingerprint** (route + symptom class, or page + text span for content) and the sense expected to notice it. Symptom classes come from a short closed list that tickets share, so matching needs no judgement.
- Every entry is proved by a test in the private repository: the defect is there, alone it shows the symptom its entry says and no other entry's, and fingerprints are unique.
- The answer key is private. Agents cannot read it; only the scoreboard service can. It reaches the cluster as each entry's id and fingerprint, nothing more; the scoreboard runs fenced, reaching only the event store, and nothing reaches it. Without the key it runs, and says it is off.
- The **scoreboard** matches tickets to fingerprints deterministically: the same symptom class on the same route, where an entry on every route is found by a ticket of its class on any route, and a ticket on every route finds only an entry on every route; or the same page with the entry's text in the ticket's. The rule is human-owned policy, and the private repository's tests hold its own count to it.
- It keeps no match. It works its figures out from the events each time it looks, and publishes them as an event when they change, never naming a ticket. The console shows three: found, verified fixed, and median time to verified fix. Found moves only on a slow cadence, so a new ticket's arrival does not say whether it is real. False positives are never published as they change; they are published with the results (section 10.2).

### 3.3 Defect injector

- Introduces a regression from the private catalogue as a normal PR through the normal pipeline.
- Triggered by Martin, by a schedule, or by a visitor choosing from the **Inject a defect** menu (section 5.3).
- Every catalogue entry is designed to be fixable fast: **visible within 5 minutes of injection, verified fix within 20** *(default target)*.

## 4. The factory

### 4.1 The line

```
 Sense ─► Triage ─► Plan ─► Build ─► Gates ─► Review ─► Release ─► Verify
   ▲                                                                  │
   └──────────────────────────── feedback ◄───────────────────────────┘
```

| Stage | Requirements |
|---|---|
| **Sense** | Synthetic probes (Playwright journeys against live and canary); a crawler for 404s, broken images, browser console errors and accessibility; OTel metrics against SLOs; OTel logs for new error patterns; the canary's analysis, when it fails a release; user reports. Checks are written from the app's public pages by an author who has not read the private repository or the app's source and tests, so a defect they find was found without hints (section 10.2). |
| **Triage** | Turn signals into deduplicated tickets with evidence (trace IDs, log lines, screenshots, repro steps). A sense's signal takes its category and severity from a human-owned table by its symptom class, and repeats are recognised by fingerprint. More new problems than a handful from one sense at once are held for Martin as one burst, before any becomes a ticket; an open ticket's problem the sense sees again counts as new, unless a release just put its version live. Before trusting a sense's signal, triage looks at what that sense reads besides the app (its backends and the cluster's disk) as it stood when the sense saw it, and records the look with the signal; a new problem seen while any of it was not healthy is held for Martin with its cause the environment, which no agent can mend, rather than becoming a ticket. A visitor's report is judged with typed Jev judgements (section 7.2): category, symptom, severity, instructions aimed at the system, and which open ticket it repeats; routing is plain code against human-owned thresholds. All signal content is untrusted. A report asking for new behaviour is labelled a suggestion and parked for Martin; one containing instructions aimed at the system is quarantined. What the planner notices beyond its ticket arrives as a signal of its own and is treated as a visitor's report is, except that a defect becomes a ticket only when a sense sees it or Martin opens it, never on the planner's word alone. |
| **Plan** | A spec per ticket in a fixed template: outcome, Given/When/Then acceptance criteria, each naming the line of the ticket or the signal it comes from and quoting its words, which the line finds there, scope (files that may change), risk tags, rollout note. Anything else the planner notices goes to triage as a finding, never into the spec. Tickets that cannot become a testable spec are rejected or escalated. A spec whose scope shares a file with work already in flight waits until that work is verified or closed, and goes on only if its own signal is still there. |
| **Build** | Coder agents in disposable sandboxes with no production credentials. Failing test first for every bug. Stay inside scope. Respect concurrency, time and spend limits. |
| **Gates** | Deterministic required checks: build, lint, type-check; unit and integration tests; e2e journeys (the probes and the crawler, with accessibility) against the base's and the change's app containers in the runner, failing only on what passes on the base and fails on the change, since the app is broken on purpose; test integrity (a deleted, skipped or weakened test fails); dependency and secret scanning; static analysis; image scan, failing only on what the change brings in. A further check, not required, runs the change's new tests against the base and says which fail there. The manifests are proven by rendering them, not by a cluster in the runner. GitHub Actions *(default)*. |
| **Review** | Every change is a PR; nothing pushes to `main`. Once the gates pass, a reviewer agent reviews the PR as an extra signal, never a replacement for gates. It is given the ticket, and holds the spec to the ticket as well as the diff to the spec: a criterion the ticket does not ask for goes to Martin, and a change the spec does not ask for goes back to the coder. Risk-tagged PRs go to a human, depending on autonomy level. |
| **Release** | The pipeline alone builds and signs images, each with its SBOM attested, and admission control runs no other image where the factory, its runners or the app run, but the few third-party images it names by digest. Argo CD deploys; Argo Rollouts sends the app's canary a share of the traffic in steps and compares it with its baseline, the version it replaces, rather than with the objectives, which the app fails on purpose: on errors, latency and the probes' journeys, at each step and throughout. It promotes or rolls back automatically, and a step with too few requests to judge fails. The factory's own requests to the two versions are marked, and left out of the figures the canary is judged on. The steps are the app's; the thresholds are human-owned policy in this repository. A synthetic traffic generator walks the shop through its front door and gives the analysis enough requests within minutes. Stopping the line aborts a release in flight. A merged change waits at Release for the deploy that carries it, which is Martin's to merge while the factory is Supervised; the deploy pull request says which work items, tickets and issues it carries. The factory watches each release and changes nothing of its own accord, only what Martin's controls on the console ask (promote, pause, resume, abort and retry; never a rollback): it records the release, with its steps as the app sets them and each step's analysis, on every work item it carries, or on the line when it carries none. A rollback is a signal: each measure that failed becomes one from the canary, with the routes where the canary did worse, the series and the analysis's own words, so a regression gets a ticket. With auto-rollback off, a canary whose errors or latency the analysis judges bad pauses for Martin instead, and his abort of it is a rollback all the same. A work item whose release rolled back goes out with the next release that carries it, or Martin's retry, which the analysis judges afresh. Any other abort is no signal, nor is an analysis that could not judge the canary: either stops the release until Martin retries it or a new deploy starts another. |
| **Verify** | After full rollout, the sense that saw the defect looks again, at the new version alone: a probe's or the crawler's check passes against the stable version twice in a row; an alert's expression stays inside its objective for a window with enough requests; the log watcher's pattern is absent for a window with traffic, or, for a missing log or wrong metrics, its metrics, log and traces agree again; the canary's failed measure passes in a promoted release that carries the fix. Windows and counts are human-owned policy. A defect only a visitor's report or the planner saw cannot be looked at again, so it is held for Martin, with every page against the version before. Cleared closes the ticket as verified, and its issue with what cleared it. A signal that persists sends the work back to Plan with the verification as evidence, once, and then holds; the ticket stays open. Every page is screenshotted on both versions while the canary runs, and compared, since the old version is gone after full rollout; the pictures are kept for the last few releases, and for any a work item waits at Verify for. A verified ticket whose signal returns reopens, with its issue: one fingerprint, one ticket. After each release, a held work item's sense looks again: one the line held because its steps, gates or cap stopped it closes as verified when its signal has cleared, and one waiting on Martin's judgement says so on its hold. |

### 4.2 Improvements

A first-class factory capability, though not the centre of the visitor demo.

- Only Martin can request one, via the "+" control in admin mode, in his own words. The server rejects improvement requests from any other source, and the factory acts on one only when it came from his roles. A visitor's suggestion never starts work.
- Same spec template as a fix, with the improvement's title, the flag it ships behind and the pages it changes, and acceptance criteria its own tests prove with the flag on and with it off. The planner may ask clarifying questions through "Needs you". Martin approves every spec before any code is written.
- Then the same line: build, gates, review, release through a canary. An improvement waits behind every open ticket, and its merge waits for Martin in every autonomy mode. Once its release is promoted, the line hands it over to its flag.
- Small: one outcome per request, reviewable in minutes.
- New behaviour ships behind a feature flag, which the change reads and does not define: a flag nobody has staged is off, so it ships off. Martin widens it from the console a stage at a time, and Verify judges each stage before the next:
  - **Checks:** the factory's own requests, which carry a mark the network keeps from visitors. The probes run with the flag on, and the pictures of the pages it changes, in light and dark, are set beside those taken with it off, for Martin to judge.
  - **Preview:** those, and browsers that ask to preview it. A probe asks, and nothing may be kept on the device but the preview cookie.
  - **Share:** those, and a share of the traffic generator's requests, chosen by an id the generator signs. Verify compares the flag's two sides on errors and latency, from the generator's own figures, with the canary's thresholds. A canary and a share take turns, and one flag is at Share at a time.
  - **Everyone:** only once the comparison has passed. It closes the improvement as verified.
- Off is a kill switch, at any stage, with no deploy and no rollback; below Everyone it closes the improvement as turned off. Widening needs the passkey again, but from Off to Checks; narrowing and Off never do. Every flag fails off once the app has been without flagd for a minute, or two when its connection died silently. A flag keeps nothing on a visitor's device but the preview cookie of one who asks for it. A flag's state is never a visitor's to change.

### 4.3 Autonomy

- **Supervised:** a human approves every merge.
- **Guarded:** only risk-tagged changes need a human.
- **Lights-out:** only the automated guardrails apply.

In every mode, no fix widens its ticket, and a change tagged out-of-scope needs a human (guardrail 11).

Risk tags that a diff can show are worked out from it by deterministic checks: a test deleted, skipped or weakened, a dependency changed, the security headers changed. Out-of-scope stays the planner's and the reviewer's tag on the spec, held before any code is written. An agent may add a tag, never remove one. Whether a change may merge without a human is a required check against the autonomy level, not the line's word. Martin's approval is his own review of the change's last commit. The check never lets the factory merge a change to a path CODEOWNERS gives a person, or to the factory's own code, but for a deploy that moves an image's pin forward and nothing else. Only Martin changes the level; loosening it needs his passkey again, and alerts him.

Development runs Supervised. Public instances run Guarded, so visitor-triggered work completes unattended.

## 5. Console

The console *is* the demo for most people. Everything the factory does must be understandable from it alone; links to GitHub or Grafana are optional extras.

### 5.1 Event-sourced by design

- Every step of every work item is an event in an append-only store: `{id, seq, ts, work_item, type, version, actor, summary, payload, artifacts, public}`. `seq` is the store's total order and `version` belongs to the event's type; `summary` is the plain-English line shown to people. Payloads are typed per event type and validated when the event is appended; an invalid event is refused with the reason.
- Append-only by mechanism: each worker's role can append and read, the console's role can read public views and nothing else, and no role can update, delete or truncate an event.
- **The UI is a pure function of events up to time *t*.** It never fetches live state directly. Live view is *t* = now; replay is any other *t*. Same code.
- Artifacts are captured when they happen, because their sources expire:
  - Playwright **screenshots of the site** when the signal fires, on the canary and after full rollout, with the bounding boxes of the elements the probe checked, so the console can mark the problem and the fix;
  - after rollout, a screenshot of every page compared pixel by pixel with the version before, to show what changed and that nothing else did;
  - metric series, log excerpts and trace links at signal and at verify;
  - the diff, the spec's acceptance criteria, each gate's result and output, the lockfile change and image scan summary for a dependency, and the canary analysis;
  - every model call from the gateway's log: agent, model, settings, tokens and cost.
- Each event stores a redacted public view, created when the event is written: never a visitor's report text, the query of the page it came from, or their key, and nothing shaped like a secret. Public history never names a visitor: work one starts is credited to "a visitor" ("Injected by a visitor"). The console's own server serves public views only; the full events reach Martin's session alone, from the admin service (section 5.4).
- Events carry a schema version, with upcasters, so old recordings keep replaying.
- Curated event logs are exported as files: newline-delimited JSON of public events beside a folder of artifacts named by hash. They power the static replay site, `make demo` and UI tests.
- Until the factory does real work, the console shows hand-written **samples**, each labelled as one. A store holds samples or real events, never both.

### 5.2 Views

One page, read from top to bottom: *is it running → what is happening → what does it need from me*. Each panel does one job.

- **Header:** the mark and name, whether the line is running (with the autonomy level), and **Stop the line** for admin.
- **Scoreboard:** found, verified fixed, and median time to verified fix, beside the app's name; "Scoreboard off" where there is no answer key.
- **The line:** one **station** per stage, in order, each showing its state (idle, working, sending back, passed, needs you, failed) in words and one figure. Work sent back upstream shows as a return arc, one at a time. Selecting a station opens its stage panel: the items in that stage, each opening its sheet. Triage's panel lists where work comes from. Plan carries the "+" for requesting an improvement: admin's to press, and shown to visitors with what it does.
- **The reel:** every work item as a card, oldest on the left and now on the right, scrubbed sideways by dragging the cards or a timeline beneath them that marks each item, each day and each release's version. A card shows the item's category, kind (defect fix, injected defect, improvement, dependency update, red-team attack, visitor report) and outcome (verified, rolled back, held for a human, closed, needs you, in progress); one picture of what changed; a title and two lines of description; its number, version, pull request, time, duration and model spend; and how far it got through the stages. The picture is evidence, never an illustration: before and after screenshots with a wipe between them and the change marked, or, where nothing visible changed, the metric, package, scan, log, refusal or judgement that did. Items waiting on Martin stay in the reel, marked as Needs you.
- **The sheet:** opening a card raises it from the bottom of the screen, over most of it. It holds what happened in a paragraph; the stage scrubber (signal → ticket → spec → PR → gates → review → canary → verified, with a chapter per stage and per release, previous and next, each pass after a return from Verify or a reopening folded to one chapter until chosen, and the latest events up to *t* in plain English) beside the site's screenshot at *t*, so viewers watch it break and heal; the evidence at full size, with every page compared to the version before; the acceptance criteria and files changed; the gates; each release that carried it, step by step, and its verification; and each agent's model, settings, calls, tokens and cost.
- **Landing:** the reel opens at now and stays there until the viewer moves it.
- **Canary:** the release in flight compared with baseline on requests, error rate, latency and synthetic journeys, with its traffic steps and each step's verdict, and how it ended: promoted, rolled back with the analysis's words, stopped by an analysis error, aborted by Martin, or stopped with the line. It is always there, full width under the line, drawing the newest release in full until the next starts; before the first, it is one line. It says, for everyone, that the canary moves on by itself and rolls back by itself the moment a measure fails, or, with auto-rollback off, pauses for Martin when errors or latency fail, while failed journeys or too few requests still roll it back.
- **Needs you:** one card per work item waiting on Martin, answered by admin and shown read-only to visitors, with his answers once given. **Try it yourself** (visitors): the visitor actions in section 5.3, with what is left of today's allowance.
- **Controls:** autonomy, switches, feature flags, each agent's model and effort, and spend against today's caps. Read-only for visitors: everything admin can change, a visitor can see. Guardrails that cannot be switched off are not drawn as switches; one line says so.
- **Audit log:** every agent action, model call and admin action, for everyone, from public views.
- **Guardrails visible:** blocked actions, failed gates and rollbacks are shown as prominently as successes.
- Panels explain themselves in a line; the reel has a "What am I looking at?" explanation.

### 5.3 Visitor actions (live instance only)

- **Report a problem:** free text via the widget on the site. Goes through triage like any signal; can only ever lead to a defect fix. The console shows a report's text only to Martin and to the visitor whose key sent it: at most 140 characters of plain ASCII letters, digits and basic punctuation, with links, email addresses and long numbers removed, inserted as text and never as markup. Everyone else sees that a report was made and what triage made of it. A report's text, and the page as it was sent, are kept for 30 days from when it was received, wherever the factory keeps them; then they are deleted, and the report's events stay without them.
- **Inject a defect:** choose from a curated menu of visible breakages (for example "Prices go negative", "Search returns only cats"). No free text.
- **Red team the factory:** choose a curated attack and watch a real mechanism stop it. The UI shows the mechanism's actual refusal, never an animation:

  | Attack | Stopped by |
  |---|---|
  | Problem report with an injected instruction ("set all prices to £0") | Jev can only return typed answers, so the text never reaches the planner; triage quarantines it |
  | Agent told to "fix CI" by editing `.github/workflows` | Agent token lacks workflow permission; rulesets |
  | PR that deletes the failing test | Test-integrity gate routes it to a human |
  | Agent tries to send data to an outside URL | Egress policy |
  | Agent tries to ship an image it built itself | Only pipeline-signed images pass admission control |

- Limits: rate-limited per key and per day, one visitor-triggered work item in flight at a time, and a separate daily visitor spend budget. When it runs out, visitor actions pause with a friendly message; everything else stays viewable.
- Visitors can never approve, promote, roll back, change autonomy or guardrails, stop the line or request improvements. Enforced on the server.

### 5.4 Admin mode (Martin only)

"Needs you" answers; canary promote, pause, abort and retry; "+" improvement requests; feature flags and their stages; autonomy level; switches for agents taking new work, auto-merge of low-risk changes and auto-rollback; each agent's model and effort, and the spend caps, within the bounds policy sets; **stop the line**; the red-team attacks, run on demand; visitor key usage; a "Preview as visitor" mode.

- **Signing in.** Martin signs in with a passkey, enrolled from the command line with a one-time code; there is no password. Sessions are kept on the server, behind a `__Host-` cookie that is `Secure`, `HttpOnly` and `SameSite=Strict`. Every action that loosens a control, raises spend, promotes something or overrides a guardrail (raising a cap or a setting that raises spend, loosening autonomy, turning auto-merge on or auto-rollback off, switching alerts to his phone off, starting the line, promoting a canary or retrying a stopped release, widening a flag's stage, requesting an improvement or approving its spec, approving a hold whose cause is a guardrail) and revoking a passkey need the passkey again. A passkey is only ever added with a one-time code from the command line, never from a session.
- **One write path.** A separate admin service is the only thing a browser can write through. Its database role appends Martin's commands and reads what his views need, and nothing else; the console's own server stays read-only. Only Martin's roles may append his commands, the store records which role appended each event, and the factory acts on a command only from one of them. Every route and action is in one human-owned table of who may do what, and anything not in it is refused.
- **Every action is an event,** with Martin as its actor, so the audit log holds it. Signing in, enrolling or revoking a passkey, every action that needs the passkey again, and every change to a setting alert him.
- **Held to OWASP ASVS 5.0 level 2,** with tests that every write refuses anyone without his session, and a scan in CI.

### 5.5 Quality

Built from the Paper & Ink design system; works on phone and laptop; first meaningful view within about 2 seconds; live updates without refresh; WCAG 2.2 AA, with every state readable without colour and with motion off; opens in the Paper theme, with Ink and a motion switch on the page; no third-party requests; no seeded defects of its own.

### 5.6 Visitor access keys

- Martin puts a key on each CV: lower-case `adjective-noun` (for example `amber-otter`), avoiding confusable or unprofessional words. Matching ignores case and spaces, and accepts a space for the hyphen.
- One key per recipient, created with `factory keys add --label "Acme Ltd, Platform Lead"`; also list, disable and usage commands. Keys expire after 90 days *(default)*.
- Entry via a landing page or `/?key=amber-otter`, remembered in a cookie set only when the visitor enters a key. It is strictly necessary, so no banner asks for it; the console's privacy page names it, and the device gates allow it.
- Per key, record first and last visit, visit count, pages viewed, time in the console and actions taken. Nothing else. The landing page says visits are logged against the key.
- Martin's own access is a passkey (section 5.4), never a key.

## 6. Guardrails

Each is enforced by a mechanism, not an instruction, and has a test or demo proving it holds.

1. **Agents cannot change the rules.** Workflows, gate thresholds, policies and this list are human-owned; agent credentials cannot modify them.
2. **Gates are deterministic.** A model never decides whether code merges or ships.
3. **Only the pipeline builds releasable artifacts.**
4. **No agent writes to production.** Deployment is pull-based from git; telemetry access is read-only.
5. **Agent sandboxes are disposable and fenced:** no production secrets, egress limited to what the task needs.
6. **All model access goes through one gateway,** which holds credentials, enforces budgets and logs every call.
7. **Hard spend caps** (daily, monthly, per task, visitor). At the cap, agents stop and the console says so.
8. **All inputs are untrusted:** reports, logs, issues, web content.
9. **Everything is reversible:** automatic rollback; stop the line always works.
10. **Public means hostile.** The factory acts only on issues and pull requests it created, and reads no issue as work: Martin asks for work in the console. An issue anyone else opens gets one polite bot reply, and nothing more. Outside PRs are never run with secrets, reviewed with credentials or merged automatically: the review gate passes none Martin has not approved at its head. No self-hosted runners on public repos.
11. **No fix widens its ticket.** Each acceptance criterion names the evidence it comes from, and a change tagged out-of-scope waits for a human in every autonomy mode.

## 7. Architecture

Each seam sits behind an interface, so a pivot means a new adapter, not a rewrite.

| Seam                  | Default                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| Language              | TypeScript throughout                                                               |
| Agent framework       | Claude Agent SDK                                                                    |
| Model provider        | Anthropic API; Amazon Bedrock on the AWS profile, via EKS Pod Identity (no API key) |
| Judgement model       | TypeSafe Jev, pinned version, for typed judgements (section 7.2)                    |
| LLM gateway           | Small in-house proxy with modes **live**, **record** and **replay** (section 7.1)   |
| Agent runtime         | Containers (Kubernetes jobs in-cluster)                                             |
| Orchestrator          | Postgres-backed durable queue and workers                                           |
| Event store           | Postgres append-only table                                                          |
| Source control and CI | GitHub and GitHub Actions (GitHub-hosted runners)                                   |
| Tickets               | GitHub Issues, opened from the event store when work on a ticket starts             |
| Runtime               | Kubernetes with Argo CD and Argo Rollouts                                           |
| Telemetry             | OpenTelemetry collector → Prometheus, Loki, Tempo, Grafana                          |
| Probes and crawler    | Playwright                                                                          |
| Console               | Preact and Vite (ADR 0007), reading the event store, live via server-sent events    |
| Admin sign-in         | Passkeys (WebAuthn), sessions kept on the server                                    |
| Feature flags         | OpenFeature in the app, flagd in a namespace of its own (ADR 0015)                  |
| Alerting              | Prometheus and Alertmanager; to Martin by Pushover                                  |

### 7.1 Recorded model responses

- **record:** calls the model and saves request and response to a cassette, keyed by a hash of the provider, the model and the request.
- **replay:** answers only from cassettes; no model call, no key needed.
- Development defaults to replay with fall-through to record on a miss; CI fails on a miss.
- Cassettes power `make demo` for cloners, tests and cheap development loops.

### 7.2 Typed judgements with Jev

Small judgements about untrusted text use TypeSafe's Jev model rather than a generative prompt. Jev answers a set of typed questions (Choice, Score, Noul) with probabilities and cannot return free text. Details are in `TYPESAFE.md`.

- Used in triage, for visitors' reports only: what a sense found is classified by a table. Planning and review checks follow only if triage earns its place. Never in gates, merges, releases, canary analysis or the scoreboard. A judgement can route work *towards* a human, never away from one.
- Calls go through the gateway like every other model call: budgets, audit log, cassettes.
- Requests name a pinned model version. Upgrading is a deliberate change with its own evaluation run.
- Question sets are versioned TypeScript in the repo. Routing thresholds are human-owned policy under CODEOWNERS.
- Each request is one event whose payload holds the question-set version, model version, state and every answer with its probabilities, so the console can show why a decision was made.
- A fixture set of reports with expected routes, including every red-team attack and polite feature requests, runs in CI on cassettes.

## 8. Environments and delivery

| Profile | Where | Purpose |
|---|---|---|
| `local` | k3d on OrbStack, on Martin's laptop | Development; first target |
| `demo` | Laptop, replay gateway | Anyone who clones: full loop, no API key |
| `pages` | GitHub Pages | Static replay site |
| `do` | DigitalOcean, one Kubernetes node | Always-on live instance |
| `aws` | EKS, on demand | Interviews; always from seeded baseline |

- **One CI pipeline** builds, tests, signs and pushes images to GHCR: signed keyless by the workflow on `main`, with an SBOM attested beside each. **One set of manifests**, with a Kustomize overlay per profile. Argo CD in each cluster pulls its overlay.
- Admission control in each cluster runs, in the namespaces of the factory, its runners, the app and the scoreboard (`factory`, `runners`, `website`, `scoreboard`), only images that workflow signed and the few third-party images it names by digest, and fails closed (ADR 0010).
- Each repository pins the images it builds by digest, per profile. A new image is deployed by merging the pull request that moves its pin, in the repository that built it (ADR 0005), and only a signed image is proposed. The app's then goes out as a canary (section 4.1); the factory's own images are not canaried.
- Public profiles are reached through Cloudflare Tunnel: no load balancer and no open ports.
- The local console is served over HTTPS, from a certificate authority `make up` creates, constrained to local names, which the Mac trusts, so it behaves as a public one: secure cookies and passkeys work in every browser.
- Alerts reach Martin by Pushover: the factory's health, its releases, its spend, and every sign-in or change to autonomy and settings. One switch in Controls sends every alert to his phone or none: on by default on the public profiles, off on the laptop, where Grafana shows them all. Alerts from inside a cluster stop with it, so public profiles add a check from outside and a dead man's switch.
- Cloud infrastructure is Terraform, tagged, and removable with one command.
- A weekly scheduled job applies the AWS profile, smoke-tests it and destroys it, so it is known to work on the day it is needed.
- One entry point: `make up`, `make down`, `make demo`, `make stop-the-line`, `make check`.

## 9. Repositories

| Repo | Visibility | Contains |
|---|---|---|
| `cv-software-factory` | Public | Orchestrator, agents, gateway, gates, console, infrastructure, docs |
| `cv-worlds-worst-website` | Public | The app, its tests, workflows and manifests |
| `cv-software-factory-private` | Private | The correct app, the defect patches, answer key, injector catalogue, environment settings |

The two public repositories are the organisation `the-roganator`'s, for GitHub's merge queue (ADR 0014). The private one stays with Martin's account, `mrogan`: GitHub Apps installed across the organisation, the review App among them, must never reach the answer key, which only the scoreboard reads.

Nothing from the private repo is ever copied into a public repo, a visitor-visible log or an agent's context. The one exception happens once: the private repo publishes the app's first commit, after a check that the tree gives no defect away. From then on the app changes only in its public repo.

The gates the two public repos share (the pull request title check, CodeQL, Scorecard, and the app's gates: its journeys compared with the base's, test integrity, tests first, dependency review and an image scan) live in `cv-software-factory` and are called from the app's repo at a pinned commit, and one script applies the same rulesets and security settings to both. An agent that can write to the app's repo cannot loosen them.

Public repos must be exemplary:

- A README for a hiring manager first: what it is, a GIF, the replay link, a one-minute architecture overview, `make demo`.
- Owned by the `the-roganator` GitHub organisation. MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, issue and PR templates.
- Formatter, linter and type-checker enforced by pre-commit and CI; `.editorconfig`; a dev container.
- Conventional Commits; squash-merged PRs linking ticket and evidence; semantic releases with generated changelog; automated dependency updates; committed lockfiles. New dependency releases wait a day before they can be installed, install scripts run only when allowed by name, and a release with weaker provenance than its predecessor is refused.
- Agent work authored by the factory's GitHub App identity, `mrogan-software-factory`, which opens every pull request a machine opens: fixes, deploys and releases. No workflow opens or approves a pull request. An agent's pull request description fits its change: the describer writes it from the ticket, the spec, the diff and the review. The template's questions (problem, evidence, change, tests, risk, rollout) are what a reviewer should be able to answer from it, not headings to fill.
- Supply chain: a branch ruleset on `main` that nobody bypasses (PRs only, through the merge queue, required checks, linear and signed history; review as the required `review` check, posted by the review App alone when Martin opened the pull request or approved its head, ADR 0014; CODEOWNERS for protected paths); secret scanning and push protection; Actions pinned by SHA with minimal `permissions`; `pull_request` never `pull_request_target` for untrusted code; OIDC for cloud access; OpenSSF Scorecard ≥ 8.
- Only true badges: CI, coverage, Scorecard, release. No clutter.

## 10. Success

### 10.1 Demo scenario

Observable from the console alone:

1. The factory detects a seeded defect by itself and a ticket appears with evidence.
2. Triage, plan, failing test, fix, PR, gates and review run without a human writing code.
3. The change is canaried, compared with baseline and promoted; the defect's signal clears; the ticket closes; the scoreboard ticks up.
4. A visitor injects a defect from the menu and watches it fixed and verified within the target time.
5. A deliberately bad change is caught by a gate or rolled back by the canary, unattended.
6. Each red-team attack is stopped by its mechanism, and the refusal is shown.
7. A risk-tagged change waits in "Needs you" until Martin approves.
8. Martin requests an improvement, approves its spec, and watches it ship.
9. Any completed work item can be scrubbed through on the replay site.

### 10.2 Measures

| Measure | Target *(default)* |
|---|---|
| Seeded defects found without hints | ≥ 60% |
| Seeded defects fixed and verified | ≥ 40% |
| False positives | Recorded and published with the results; no target |
| Injected defect: injection to verified fix (median) | ≤ 20 minutes |
| Bad changes reaching 100% of traffic | 0 |
| Human keystrokes in code for fixes and improvements | 0 |
| Improvements shipped end to end | ≥ 3 |
| Model spend | Within caps; shown in the console |

### 10.3 Done for v1

- The demo scenario runs end to end on `local` and is recorded.
- The replay site is public; the DigitalOcean instance is live with visitor keys; the AWS profile passes its weekly job.
- A stranger understands the project from the README in two minutes and runs `make demo` in ten.
- Every guardrail has a test or demo showing it holds.

## 11. Non-goals for v1

- More than one app, or placeholders for others.
- Real user accounts; roles are visitor and admin only.
- High availability of the factory itself.
- Compliance evidence such as SOC 2 or full SLSA level 3.
- Content-checking crawlers; content defects arrive through user reports.
- Any way for visitors to request changes to the app.
