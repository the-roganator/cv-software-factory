# Milestone 6: Shipping safely

## Outcome

The factory finishes what it starts. A fix that Martin has merged ships as a signed image that admission control lets in, runs as a canary beside the version it replaces, and is compared with it on errors, latency and the probes' journeys while a traffic generator gives the comparison enough to go on. The canary promotes itself or rolls itself back. After full rollout the factory checks that the signal behind the ticket has cleared: if it has, the ticket and its issue close and the scoreboard ticks up; if not, the work goes back round the line.

A deliberately bad change that passes every gate is rolled back by the canary with nobody touching anything, and the rollback becomes a ticket of its own.

The factory stays Supervised: Martin still merges each fix and each deploy pull request. Everything after the deploy merge is unattended.

The milestone is built in three parts, each by its own implementing session, because one context cannot hold all of it:

- **Part A, the runway:** signing, admission control, Argo Rollouts, the canary's analysis and the traffic generator. Every release of the app goes out as a canary and is judged by its numbers, proved with no line in the loop.
- **Part B, the line after the merge:** the line carries a work item through Release and Verify, closes or reopens its ticket and issue, and turns a rollback into a signal.
- **Part C, the score and the show:** the scoreboard, the console's Canary panel and new states, and the runs that show the whole of it.

Each part starts when the one before has met its criteria and its pull requests are merged. Each leaves `COMPONENTS/` and `AGENTS.md` describing what it built, so the next session starts from this file, those two and the code, and needs nothing from the session before.

## How each part is built

The part's session orchestrates. It gives each pull request to a sub-agent of its own, and keeps its context for the stack. The sub-agent, for its pull request:

1. Builds the task with its tests, and passes `make check`.
2. Has a fresh sub-agent invoke the `code-review` skill with the Skill tool, really invoking it rather than reviewing in its style, on the branch against its base (`medium <base>...<branch>`, the base `origin/main` or `origin/<branch below>`), and fixes what it finds. Where a miss is a hole rather than a bug (tasks 1, 2, 8 and 13), the `security-review` skill as well, given the worktree's own diff (`git -C <worktree> diff <base>...HEAD`), since in a worktree it finds an empty one. Each runs once; a second runs only after a major change.
3. Writes a short note on the change (why, the decisions it took and turned down, what it left out and where that went, how it was tested) in `scratch/pr/`, and runs `/visual-pr` with the base and the note. The skill writes the description in a context of its own, so the sub-agent's full context does not have to hold the whole diff again.
4. Pushes, and opens the pull request with that description. Copilot reviews it once, on its own, on the first push; nothing requests that review, and later pushes are not reviewed.
5. Answers Copilot. Fixed: reply with the commit and resolve. Wrong: reply with why and resolve. Arguable, or outside the task: reply and leave it open for the orchestrator. `main` needs every conversation resolved before a merge. A second Copilot review is the orchestrator's call, made only after a major change or when a sub-agent disagrees with Copilot.
6. Reports to the orchestrator: the pull request, what each review found, how it was answered, and what is left open.

Then the orchestrator reviews the stack as a whole, and fixes bottom up, one sub-agent to a pull request, rebasing what is above each fix before anything is pushed again.

## Decisions

### The supply chain

- **Only images the pipeline signed run.** Each repository's `build.yml` signs every image it pushes, by digest, with cosign's keyless signing and the workflow's own OIDC identity, and attaches an SBOM from Syft as a signed attestation. There is no signing key to keep or steal. A signature says which workflow, in which repository, on which ref made the image.
- **Kyverno admits a pod only if its image carries that signature.** In `website`, `factory` (where the console runs too), `runners` and, from Part C, `scoreboard`, a pod's images must be referenced by digest and signed by `build.yml` on `main` of the repository that builds them, and every other registry is refused, but for the few third-party images the policy names by digest with a reason (Postgres, in `factory`). It checks the signature, not the SBOM: the deploy pull requests' checks verify that, where parsing it is cheap. A refusal names the policy and the image. Kyverno fails closed: if it cannot verify, the pod does not start. Its own namespace, Argo CD's and the cluster's system namespaces are left out, so the cluster can always start again; telemetry's and Argo Rollouts' are not guarded, since they run only upstream charts. ADR 0010.
- **Images built on the Mac still run, by Martin's choice.** Running an unmerged image on the local cluster (the `try-the-line` skill) means switching the factory side's policy to audit for the run; Argo CD puts it back when self-heal resumes. The `website` policy stays enforced, always.
- **Deploy pull requests check what admission will check.** The deploy watch proposes only a digest whose signature verifies, and the deploy pull request's checks verify it again, so a pull request that Martin merges never pins an image the cluster would refuse.

### The canary

- **Only the app is canaried.** The factory's own images are signed and admitted, and deploy as they do now. A canary needs traffic to judge, and the app is the only thing with traffic that matters.
- **Argo Rollouts runs the app.** The app's Deployment becomes a Rollout with a stable Service and a canary Service, and Traefik splits the ingress's traffic between them by weight, set by Argo Rollouts. Merging a deploy pull request is still the deployment (ADR 0005): Argo CD applies the new digest, and the Rollout starts a canary from it.
- **The steps are the app's; the judgement is the factory's.** The Rollout's steps live in the app's `deploy/`, which CODEOWNERS gives to Martin and the scope fence keeps from agents. To start: 25% for three minutes, 50% for three minutes, then 100%. The analysis lives in this repository: `policy/release.ts`, which CODEOWNERS gives to Martin, is rendered to a ClusterAnalysisTemplate, as `policy/objectives.ts` is rendered to Prometheus's rules, so nothing in the app's repository can loosen it.
- **The canary is judged against the version it replaces, not against objectives.** The app is broken on purpose, so the version already running fails some objectives; a fix that leaves those as they are is no worse. Three measures, at each step and in the background throughout:

  | Measure | Fails when | From |
  |---|---|---|
  | Errors | the canary's share of 5xx answers is more than a point above the baseline's | Prometheus |
  | Latency | the canary's p99 is more than a quarter above the baseline's, and more than 100 ms above it | Prometheus |
  | Journeys | a check passes on the baseline and fails on the canary, twice | the journeys gate's comparison, run against the two Services |

  The figures are a start, in `policy/release.ts`. A step with too few requests to judge fails, with that as its reason: a change nobody could judge does not reach everyone.
- **Canary and baseline are told apart by Argo Rollouts' pod-template hash.** The collector adds each pod's labels to the app's telemetry, and the analysis queries by the hash Argo Rollouts gives the stable and the canary. The queries sum over routes, so they do not depend on how the app names a route.
- **The journeys measure is the journeys gate, aimed at the cluster.** An analysis Job from the `factory-browser` image runs the same comparison the app's pull requests pass, with the stable Service as the base and the canary Service as the change. One comparison, two places.
- **The traffic generator walks the shop through the front door.** `factory traffic`, in the `factory` image, requests the app's public pages and its search at a steady rate set in `policy/release.ts`, through Traefik, so the split applies to it as to anyone. It runs all the time, so the objectives have traffic too. It never sends a report or the contact form. At about five requests a second, a 25% step of three minutes gives the canary over 200 requests.
- **The senses watch the stable version.** The probes and the crawler look at the stable Service, which is what the shop is between releases. Through the split ingress, `/version` would flip between requests and the senses would throw away every run. The canary is judged by the analysis, not by the senses.
- **A rollback leaves the bad commit on the app's `main`.** Argo Rollouts keeps the baseline running, and every later release carries the bad commit until a fix for it merges, so the next canary fails the same way. That is the gate holding, not a fault: the rollback's own ticket is the way out, and Martin can revert by hand.

### The line after the merge

- **The line carries a work item to Verify.** `release` and `verify` join the line's stages. A merged work item waits at Release under a hold whose cause is the deploy pull request: while the factory is Supervised, that merge is Martin's, and Needs you lists it. The deploy pull request says which work items and tickets it carries, with their issues, so Martin can tell what he is shipping.
- **The line reads the Rollout and changes nothing.** It may get, list and watch Rollouts and AnalysisRuns in `website`, and nothing else there. A release carries every merged work item whose commit is in its image and not in the one before; each gets the release's events, with actor `rollouts`: `release.started` (digest, signed, admitted), `canary.stepped` with each step's analysis, and `release.promoted` or `release.rolled-back` with the series compared. A release that carries no work item (Martin's own commits, Dependabot's) has its events on the line itself, with no work item: the Canary panel and the Release station show it, and if it rolls back, its ticket brings it to the reel.
- **A rollback is a signal.** The line sends one to triage for each measure that failed, with the routes where the canary did worse, the series and the analysis's own words, under the symptom class the measure stands for (`server-error`, `slow-response`, or the failing journey's own). Triage treats it as any sense's signal, so a regression gets a ticket, a fingerprint and a place in the queue. A work item whose release rolled back stays at Release and goes out with the next release that carries it.
- **Verify asks the sense that saw the defect.** After full rollout, the line checks the ticket's own signal against the new version:

  | The ticket came from | Cleared when |
  |---|---|
  | A probe or the crawler | its check, run again against the stable Service, passes twice in a row |
  | An alert on an objective | the alert's expression, over the new version only, stays inside the objective for a window with enough requests |
  | The log watcher | no record of the pattern from the new version for a window with traffic |
  | Only a visitor's report | nothing can tell: the work item holds for Martin, with the screenshots before and after |

  Windows and counts are in `policy/release.ts`.
- **Cleared closes; persists sends the work back.** A cleared signal appends `verification.finished` and closes the work item as verified; the App closes the ticket's issue with what cleared it. A signal that persists returns the work item to Plan with the verification as evidence, once; a second time, it holds for Martin. The issue stays open either way.
- **A closed ticket reopens when its signal returns.** One fingerprint, one ticket: a signal on a verified ticket's fingerprint reopens that ticket and its work item, and the App reopens its issue. The regression is the same defect, not a new one.
- **Pictures are taken while both versions run.** During the canary the probes worker screenshots every page on the stable and on the canary, and compares each pair pixel by pixel; at Verify, those comparisons become the "every page against the version before" evidence, a page marked intended when it is the ticket's own. After full rollout the old version is gone, so the pictures cannot wait.
- **Stopping the line stops agents, and aborts a canary in flight.** `make stop-the-line` runs from Martin's own kubeconfig: it appends `line.stopped`, as now, and aborts any Rollout mid-canary, so the baseline takes all traffic. An aborted release stays aborted until Martin retries it or a new deploy starts another; starting the line does not resume it. The factory itself holds no right to change a Rollout.

### The scoreboard

- **The scoreboard is the only reader of the answer key.** `factory scoreboard` runs alone in a `scoreboard` namespace. `make up` reads each entry's id and fingerprint, and nothing else, from the private checkout (`PRIVATE_DIR`, by default beside this one) into a Secret there, through stdin and no file, as it does the model keys. No other service account can read that namespace's Secrets, and its pod reaches Postgres and nothing else; nothing can call it. A cluster with no private checkout runs it without a key, and the console says the scoreboard is off.
- **It matches by fingerprint alone.** A ticket matches an entry with the same symptom class on the same route, or the same page with the entry's text in the ticket's. An entry on `*` is matched by a ticket of its class on any route; a ticket on `*` matches only an entry on `*`. The rule is in `policy/scoreboard.ts`, which CODEOWNERS gives to Martin; the private repository imports it, and its tests check it agrees with `workshop/count.ts`.
- **It publishes figures, not matches.** It appends `score.updated`, with no work item, whenever a figure changes: found (entries with a matching ticket), verified fixed (entries whose matching ticket was verified), the median time from a matched ticket's first signal (or its opening, with none) to its verification, and false positives (tickets that match no entry). Which ticket matched which entry is kept nowhere: the scoreboard works the figures out from the events on each pass and keeps nothing, since a per-ticket verdict anywhere would tell anyone reading it which open tickets are real. Found moves only on a slow cadence, every six hours, so a new ticket's verdict is hidden among those opened beside it; verified and the median move when they change. The console shows the first three figures; the fourth is never published as it changes, and `factory scoreboard --print` prints it for the results (spec 10.2).

### Events

- **Events change by version, as in milestone 5.** The release events and `verification.finished` exist, written so far only by the samples; where their shape changes, they gain a version 2 with an upcaster, and the samples move to it. New: `score.updated`, and whatever reopening a ticket needs that the console's REOPENED chapter does not already read.

## Part A: the runway

Each task is its own pull request, in order, each demonstrable.

### 0. Settled before the start

- Martin has agreed the decisions above, and settled anything this file asks him: the steps, the analysis's figures and the traffic rate in particular.
- The app's deploy pull request waiting today carries the fixes for work items 1001 and 1006 (app #17 and #25). It stays open until the canary is in place, so they ship through the first canary, and Part B verifies them.

### 1. Signed images

- Both `build.yml` workflows sign each image by digest, keyless, and attach the Syft SBOM as an attestation, with `id-token: write` for that job only.
- The deploy watch checks a digest's signature before it proposes it, and the deploy pull request's checks verify it again.
- `cosign verify` against each repository's identity passes for a new image, and fails for an image built and pushed by hand.
- The app's repository gets a `.github/copilot-instructions.md` like this one's, pointing at its `docs/REVIEWERS.md`, with its first pull request of the milestone, so Copilot reviews the app's changes against the app's rules.

### 2. Admission control

- Kyverno, installed by Argo CD from its chart at a pinned version, in a namespace of its own, before anything it guards.
- The policy, as the decisions say; its NetworkPolicy lets Kyverno's admission controller reach GHCR and Sigstore's trust root. A NetworkPolicy cannot name a host, so the rule is the internet on 443 outside private addresses, as for the GitHub worker; egress by host name waits for milestone 10 (#176).
- An unsigned image, and one signed by another identity, are refused in each guarded namespace, and Kyverno's words are kept (`deploy/test/admission-refusals.json`), as milestone 5 kept the App's refusal to write a workflow: milestone 9's red team shows them.
- The `try-the-line` skill switches the factory side's policy to audit for a run, and checks it is back to enforce afterwards.

### 3. Argo Rollouts

- Argo Rollouts, installed by Argo CD at a pinned chart and image. Its Traefik traffic router is built in, for Traefik 3's `traefik.io` API, so no plugin is fetched at start.
- In the app's repository: the Deployment becomes a Rollout with the steps above, a stable and a canary Service, and the ingress routed through Traefik's weighted service. The website AppProject allows what that needs, and nothing cluster-scoped.
- The collector adds pod labels to the app's telemetry.

### 4. The analysis and the traffic generator

- `policy/release.ts`, and the ClusterAnalysisTemplate rendered from it, with a test that the two agree (as the alerting rules have).
- The journeys comparison as an analysis Job, from `factory-browser` at a pinned digest.
- `factory traffic`, with its NetworkPolicy: DNS, Traefik and the collector, and nothing else.
- A step with too little traffic fails, and says so.

### 5. Stop the line, and the fences

- `make stop-the-line` aborts a canary in flight.
- `make egress` covers Kyverno, the Rollouts controller, the analysis Job, the traffic generator and the app's own pods, which a NetworkPolicy from this repository fences: DNS and the collector out; Traefik, the probes, the crawler and the analysis in.

### 5a. Admission enforces (#173)

Each copy of the policy goes from Audit to Deny on its own, in a pull request that deletes its patch in `deploy/base/admission/kustomization.yaml`, once every image its namespaces run or will start would be admitted:

- **`factory-images`** (`factory`, `runners`), once the factory's and the console's deploy pull requests that pin signed digests have merged and are running, and `make admission-ready` lists nothing refused in those namespaces. Before task 6.
- **`website-images`**, once the app's first signed deploy is running and the factory's deploy pull request that pins a signed `factory-browser` has merged, and `make admission-ready` says Ready. The canary's journeys Job runs `factory-browser` in `website`, so with it unsigned every journeys Job would be refused and every release rolled back. The app's first signed deploy is task 6's good release, so this copy enforces between task 6's two runs, and the bad release goes out under it.
- The kept refusals (`deploy/test/admission-refusals.json`) gain the `misplaced` case, an image of ours in a namespace whose copy does not admit it, when `scripts/admission-refusals.sh` next runs on a cluster with Kyverno.
- The comment in `deploy/base/runners/line-access.yaml`, which says admission will refuse a runner Job's other images once `factory-images` enforces and reports them until then, says that it refuses them.

### 6. The first canaries

On the local cluster, with no line in the loop:

- **A good release:** Martin merges the app's waiting deploy pull request; the canary goes through its steps, the analysis passes each, and it promotes itself. The step timings, request counts and each measure go in this file's results.
- **A bad release:** with both copies of the policy enforcing, a drill on the app's `main`, written to pass every gate and fail under load (a lock that serialises requests, say, which a single probe never notices). Its deploy pull request merges, the canary fails its analysis and rolls back before 100%, and nobody touches anything. Then Martin reverts it by hand, and the revert's release promotes.

### 7. Documentation for Part A

`COMPONENTS/` (supply chain, admission control, progressive delivery, the traffic generator, the guardrails it makes real), `AGENTS.md` (the traffic generator on the host; trying an unmerged image under admission), `TERMS.md` (canary, baseline as the version a canary is compared with, as distinct from the seeded baseline, rollback, and abort as distinct from a rollback), ADR 0010, and spec sections 4.1 and 8.

### Part A is done when

- [x] Every image both repositories build is signed by their pipeline, with its SBOM attested.
- [x] Both copies of the policy enforce, and an image the pipeline did not sign is refused in every guarded namespace, as is an image of ours in a namespace that does not run it; the refusals are kept.
- [x] Merging a deploy pull request runs the app's release as a canary that the analysis judges on errors, latency and journeys against the baseline, with enough traffic to judge, and that promotes itself.
- [x] A change that passes every gate and fails under load is rolled back by the canary, unattended, before it reaches 100%.
- [x] `make stop-the-line` aborts a canary in flight, and `make egress` passes with the new parts.

## Part B: the line after the merge

### 8. Release

- `release` and `verify` in the line's stages and its table; the machine stays a pure function of a work item's events.
- The deploy pull request lists the work items, tickets and issues it carries. A merged work item holds at Release for it.
- The line's read-only watch of the Rollout and its AnalysisRuns, and the release events, on each work item a release carries or on the line itself.
- Work items that merged before this part (1001 and 1006) take their place at Release; if their commit is live already, Release records that and Verify runs.

### 9. Verify, close and reopen

- Verification for each kind of ticket, as the decisions say, with `verification.finished`.
- Closing: the work item closes as verified, and the App closes the issue with a comment saying what cleared it.
- Persisting: back to Plan with the verification as evidence, once, then a hold.
- Reopening: a signal on a verified ticket's fingerprint reopens the ticket, its work item and its issue (a new action for the GitHub worker, which the dry run records too).

### 10. Pictures

- The probes worker screenshots every page on the stable and the canary while the canary runs, with each pair compared pixel by pixel, as artifacts.
- The ticket's own page at signal, on the canary and after rollout, with the checked element's box, for the sheet's wipe.

### 11. A rollback is a signal

- A failed analysis sends a signal per failing measure, as the decisions say; triage opens a ticket for it, or adds to the ticket it repeats.
- Martin's abort (`make stop-the-line`) and a failed analysis both leave the Rollout Degraded with reason `RolloutAborted`; only the analysis's abort adds its own words to the message. So the signal comes from an AnalysisRun whose phase is Failed, never from the Rollout's state: an abort terminates the release's AnalysisRuns (`Run Terminated`), and terminating one does not fail it, so an abort is no signal.
- The dry run answers for a release, so a soak still goes round: a dry-run work item is released and verified by the dry run's word, and says so.

### 12. Documentation for Part B

`COMPONENTS/` (the line through Verify, the release watch, verification by sense), `TERMS.md` (verification, and the line now carrying work to it), spec section 4.1's Release and Verify, and ADR 0011 if verifying by the ticket's own sense needs its reasoning kept.

### Part B is done when

- [x] Work items 1001 and 1006 are verified against their own checks, and their issues (app #16 and #24) are closed by the App with what cleared them.
- [x] A release's events, step by step, are on every work item it carries, and a release that carries none is on the line.
- [x] A rollback opens a ticket with the series that condemned it.
- [x] A signal that persists after release sends its work item back to Plan, and a verified ticket whose signal returns reopens, each shown by a test and by one run.

## Part C: the score and the show

### 13. The scoreboard

- `factory scoreboard`, its namespace, its Secret from the private checkout and its fences, as the decisions say. Admission control guards the namespace, and the admission tests refuse an unsigned image there too. `make egress` shows it reaches only Postgres, and a test shows no other service account can read its Secret.
- `score.updated` when a figure changes, and the figures checked against `workshop/count.ts` over the same tickets.

### 14. The console

- The Canary panel: the release in flight against its baseline on errors, latency and journeys, with its steps, for everyone. Promote, hold and roll back are admin's, in milestone 8; the panel says the canary decides for itself.
- The scoreboard beside the app's name: found, verified fixed, and median time to verified fix.
- Release and Verify for real work items: the hold for the deploy, each step's analysis, the rollback picture, the wipe at signal, canary and rollout, every page against the version before, a return from Verify, a reopened ticket, and a release with no work item.
- New states are designed and agreed with Martin before they are built, and added to the design system's README as a section of their own. Snapshots are updated in the pinned image.

### 15. The runs

On the local cluster, on Claude, at Supervised:

- **A fix all the way.** The line takes a ticket by its own rule and carries it through Plan, Build, Gates and Review to Martin's merge, and on through his deploy merge, the canary, promotion and Verify, until its issue closes and the scoreboard ticks up. Nobody chooses the ticket or reads the private repository. How long each stage took, from the signal to verified, goes in the results.
- **A bad change, unattended.** A drill as in Part A, released with a fix: the canary rolls it back, the fix's work item waits at Release, and the rollback's ticket is in the reel. If the line takes that ticket, its fix and its release go in the results too.
- Martin watches both in the console, on a laptop and a phone, and approves them against `INTENT.md`.

### 16. Documentation and retrospective

Spec sections 3.2, 4.1 and 5.2; `COMPONENTS/` (the scoreboard, the console's new panels); `TERMS.md` if anything needs pinning down; this file's results and retrospective; open question 3 with what the runs measured; the issues.

## Exit criteria

- [x] Parts A and B's criteria are met.
- [x] A seeded defect is found, fixed, merged, shipped as a signed canary, promoted, verified by its own signal clearing, and closed, with its issue, with no human code and nobody touching it after the deploy merge. The scoreboard counts it. Every step is in the console.
- [x] A bad change that passes every gate is rolled back automatically, never reaches all traffic, and opens a ticket.
- [x] No image the pipeline did not sign runs in a guarded namespace.
- [x] Only the scoreboard can read the answer key, and nothing but its figures leaves it.
- [x] Martin has watched a fix and a rollback in the console, on a laptop and a phone, and approved them against the bar in `INTENT.md`.

## Out of scope

- Promote, hold and roll back from the console, the auto-rollback switch, and answering Needs you there (milestone 8).
- Guarded autonomy, where the gates rather than Martin merge a deploy pull request (milestones 8 and 10).
- The injector and its menu (milestone 9): this milestone's drills are Martin's own commits.
- Canaries for the factory's own images.
- Dependabot's pull requests as work items of their own: their releases are on the line, with no card unless they roll back.
- Profiles other than `local` (milestones 10 and 11).
- Admission on SLSA provenance, beyond the signature.

## Risks

- **The laptop runs out of room.** Kyverno, Argo Rollouts, a second copy of the app and the traffic generator join a cluster that already runs the line. Part A measures what each takes, and the traffic rate is policy.
- **Admission fails closed, so an outage stops every pod.** GHCR or Sigstore out of reach, or Kyverno itself down, and nothing in a guarded namespace starts. Kyverno caches what it has verified, its own namespace and the system's are left out, and `make up` installs it before what it guards. Its cache is in memory, so a Kyverno that restarts verifies everything again; its memory grows with the largest Sigstore bundle attached to an image, its attestations' included, which its limit allows for; and the policy verifies the signature, not the SBOM.
- **A noisy baseline makes a noisy verdict.** The seeded defects make some routes slow or failing by design. The analysis compares with the baseline rather than objectives, sums over routes, and needs two journey failures; each rollback in the runs is checked by hand for whether it was earned.
- **The traffic generator wakes the objectives.** Seeded slow routes that were too quiet to alert will alert under traffic. They are real defects, triage deduplicates them by fingerprint, and the scoreboard counts what they find; the results say how many tickets the traffic brought.
- **A rollback holds every release behind it.** Until its fix merges, each release carries the bad commit. Its ticket takes its place in the queue by severity, and Martin can revert.
- **A change can pass by not reporting its errors.** The analysis judges errors and latency on the app's own telemetry, and agents write the app's code. The collector, not the app, says which version a record came from (task 3), and "enough requests" is counted at Traefik (task 4), but the errors and the latency are still the app's word. Judging them at the ingress too would close that, though Traefik's latency buckets are coarse by default; it matters by milestone 9, whose red team would try it. Traefik also counts per Service, not per version, so a new canary started within a step's window of an aborted one briefly counts the aborted canary's requests as its own.
- **The answer key leaks.** Only ids and fingerprints reach the cluster, only the scoreboard can read them, and only its figures leave it.

## Results

### Part A

On the local cluster, on 10 October 2026. Times are UTC and come from the Rollout's conditions and its AnalysisRuns. An error figure is the canary's share of 5xx answers less the baseline's, in percentage points, against a limit of one point; a latency figure is how far the canary's p99 is under its limit; "enough requests" is counted at Traefik.

- **Signed, and admitted.** Every image both repositories build is signed by `build.yml` on `main`, with its SBOM attested. Both copies of the policy enforce (#185, #186), checking the signature and not the SBOM (#184), and `make admission-ready` says every image `factory`, `runners` and `website` run or will start is admitted: our images signed, Postgres by digest. Kyverno's refusals of an unsigned image, one signed by another identity, and an image of ours in a namespace whose copy does not admit it are kept for each guarded namespace (`deploy/test/admission-refusals.json`).
- **Stop the line, and the fences.** At a canary's 50% step, `make stop-the-line` took 2.8 seconds: the Rollout was aborted, Traefik's weights went to 100 and 0, and `line.stopped` was appended. Starting the line left the release aborted, and retrying it took it back to 25% and on to promotion. `make egress` passed all 89 of its checks. Both were run for #175, before either copy of the policy enforced.
- **A good release** (the app's #20, the fixes for work items 1001 and 1006). The canary started at 21:13:04 and promoted itself at 21:20:02, 6 minutes 58 seconds later.

  | Step | Measured at | Requests | Errors | Latency | Journeys |
  |---|---|---|---|---|---|
  | 25% | 21:16:14 | 217 | 0.36 points below | 100 ms under | pass |
  | 50% | 21:19:38 | 480 | 0.38 points below | 98 ms under | pass |

  The background analysis looked seven times at errors and latency; the first two found nothing to compare yet, and every look passed. The journeys passed both times they ran.
- **A bad release, unattended** (the app's #35 and #36: a release that adds a lock around request handling, holding each request 40 ms). It passed every gate, and went out with both copies of the policy enforcing. The canary started at 22:44:56. The background analysis failed latency at 22:46:56 (234 ms over its limit) and again at 22:47:56 (247 ms over), and the Rollout rolled back at 22:47:56, at the 25% step, three minutes in: "Metric "latency" assessed Failed due to failed (2) > failureLimit (1)". Nobody touched it. Errors failed once, at 22:46:56, 1.19 points above the baseline's share; the next look was 0.19 points above, within the limit, so errors alone would not have failed the release. The journeys passed at 22:47:41.
- **The revert** (the app's #37 and #38). The canary started at 22:57:46 and promoted itself at 23:04:42, 6 minutes 56 seconds later.

  | Step | Measured at | Requests | Errors | Latency | Journeys |
  |---|---|---|---|---|---|
  | 25% | 23:00:54 | 224 | 0.19 points below | 101 ms under | pass |
  | 50% | 23:04:18 | 444 | 0.17 points below | 99 ms under | pass |

### Part B

On the local cluster, on 11 October 2026, with the line's models on Claude. Times are UTC and come from the line's events. A release is named by the canary's pod-template hash, with the app's commit after it. A step's figures are the ones the line recorded on `canary.stepped`, for the canary and the baseline: requests, the share of 5xx answers, and p99 latency. A cost is what the gateway counted for one agent's step, in dollars.

- **1001 and 1006 verified.** Release found their fixes live on release 68ff668868 (464cd31), and Verify ran their own probe checks: `home-links-open` for 1001 and `search-takes-any-typed-text` for 1006 passed twice each. By 13:58 both had closed as verified, and the App closed the app's #16 and #24, each with a comment saying which check cleared it. It needed migration 0008's row move run again by hand. The migration went out with the console's deploy (#203) while the old line image still ran, and that image set the two rows back to ended. Martin ran the move again.
- **A release on the line, rolled back, and its ticket** (the app's #39 and #40: the lock from Part A's bad release again). Release 68789944b6 (e8f8808) carried no work item, so its events went on the line. It started at 14:36:56 and rolled back at 14:39:56, during the 25% step, before any step was measured, so it has no `canary.stepped`. Latency failed twice, against a failure limit of one, with the canary's p99 at about 380 to 460 ms and its value 276 ms over the limit. The line sent triage the failed measure, and triage opened ticket 1034, "Slow responses in a canary release" (`slow-response` on `*`, performance, degraded), with the routes where the canary did worse and the series as evidence. The line did not take it: LINE_TAKE was used up.
- **The revert's release on the line** (the app's #41 and #42). Release 9864fc5cb (680c351) carried no work item. It started at 14:53:31 and promoted at 15:00:01, 6 minutes 30 seconds later.

  | Step | Recorded at | Canary | Baseline |
  |---|---|---|---|
  | 25% | 14:56:31 | 590 requests, 1.11% 5xx, p99 42 ms | 1,252 requests, 1.57% 5xx, p99 40 ms |
  | 50% | 15:00:01 | 838 requests, 1.43% 5xx, p99 40 ms | 939 requests, 1.63% 5xx, p99 43 ms |

  The journeys' figures are empty on both steps.
- **Ticket 1035, carried through Release, persisting.** A drill (the app's #43 and #44) has `/` catch an error, log it, and still answer 200. Its release, 5f4d5fd6fd (43896d2), started on the line at 15:12:35. The log watcher saw the new pattern, and triage opened ticket 1035, "Server errors on /" (logs, `server-error`, broken), at 15:14:24. The line took it with LINE_TAKE at 6 and LINE_ONLY at 1035 (#207), and carried it from 15:23 to its merge hold at 15:28:56: the planner ($0.049), the coder ($0.062), 13 gates passed, the reviewer ($0.030) and the describer ($0.054), about $0.20 in all. Its fix is the app's #46, under issue #45. #208 took LINE_ONLY away again, so the deploy pull request (#48) would say what it carries, and it listed 1035. To make the signal persist, a revert of #46 (the app's #47) was meant to merge before the deploy; the test-integrity gate refused it, since it deleted #46's tests, and it was closed. A second drill (the app's #49) logs an error on `/` through a logger of its own, in `src/greeting.ts`, which #46's tests do not see. Release 867c4b7f55 (192dfe7) carried 1035, and its events went on 1035.

  | Event | Recorded at | Canary | Baseline |
  |---|---|---|---|
  | `release.started` | 15:53:40 | | |
  | `canary.stepped`, 25% | 15:57:10 | 589 requests, 1.30% 5xx, p99 36 ms | 1,296 requests, 1.52% 5xx, p99 42 ms |
  | `canary.stepped`, 50%, and `release.promoted` | 16:00:40 | 843 requests, 1.55% 5xx, p99 42 ms | 889 requests, 1.35% 5xx, p99 42 ms |
  | `verification.finished`, persists | 16:30:43 | | |
  | `work.returned`, Verify to Plan | 16:30:58 | | |

  Verification found the pattern's lines from 192dfe7 ("GET / found no greeting: Error: No greeting is set for this hour"), with screenshots of 12 pages, `/` marked intended.
- **1035's second pass, verified.** The planner ($0.064), the coder ($0.272), the reviewer ($0.040) and the describer ($0.063), about $0.44, and about $0.63 for 1035 so far. The fix, the app's #50, removes the call that logged, with tests that read the app's output at every hour of the day. Release 6c9894bdfd (8255dac) carried 1035: started at 16:47:28, and promoted at 16:54:28.

  | Step | Recorded at | Canary | Baseline |
  |---|---|---|---|
  | 25% | 16:50:58 | 576 requests, 1.70% 5xx, p99 35 ms | 1,026 requests, 1.17% 5xx, p99 43 ms |
  | 50% | 16:54:28 | 839 requests, 1.43% 5xx, p99 38 ms | 946 requests, 1.61% 5xx, p99 42 ms |

  At about 17:24, verification cleared: "No error like the one the log watcher saw came from 8255dac in 30 minutes, over 294 requests". 1035 closed as verified, and the App closed issue #45 as completed.
- **1035 reopened.** A third drill (the app's #52) has every hundredth visit to `/` log a different error, a new pattern with the same fingerprint. Once 5b5702d was released, triage reopened 1035 at 18:00:24 (`work-item.reopened`, from the logs, on `/`, "new error pattern"), with the signal that reopened it. The App reopened issue #45, with a comment that begins "It came back after its fix was verified". The line took 1035 back into Plan: the planner at 18:01:05 ($0.057) and the coder at 18:01:56 ($0.091). The third fix, the app's #54, removes the counter, with a test of 250 visits; it passed 13 gates and review at 18:05, and held for Martin's merge at 18:06:25. He merged it and its deploy, and its release (7fd45f66f) was in its canary as this was written. 1035 has spent $0.879 over three passes, of its $1 cap.

### Part C

On the local cluster, on 12 October 2026, with the line's models on Claude. Times are UTC and come from the line's events, but for merges and deploy pull requests, whose times are GitHub's. A release is named by the app's commit it ships.

- **Built.** The line records the canary's steps on `release.started` (#219). The scoreboard counts tickets against the answer key (#220) and runs alone in its own namespace, fenced (#224), by the rule in `policy/scoreboard.ts`, which the private repository imports and checks against its own count (its #6). The pictures box only the ticket's own check (#218), and are deleted once no release needs them (#221). The factory's own requests to the app send `x-unmeasured`, and are left out of the canary's figures (#222, and the app's #58). In the console: the states shipping brings, designed and agreed first (#223); a return drawn only until its work moves on, and boxes where they belong (#225); the samples' last week, shipped as the line ships (#231); the Canary panel (#232); the scoreboard beside the app's name (#233); a work item's releases and verification on its sheet (#234); and each release's version on the timeline (#237). #230 fixed how `make egress` asks about pods' subresources. The deploys: #217, #226, #227, #228 and #229; the line's limits for the runs: #238, #239, #241 and #242.
- **The fences.** Every copy of the policy enforces, `scoreboard-images` included, and Kyverno's refusals in `scoreboard` are kept with the others. `make egress` passes: the scoreboard reaches Postgres and DNS and nothing else, and no service account of ours, or of a chart but Argo Rollouts' controller, may read its Secrets. `scoreboard-fences.test.ts` holds deploy/ to the same, and to nothing reaching it. The answer key reached the cluster as each entry's id and fingerprint, through stdin (`make scoreboard-secrets`), and the scoreboard has published from it since.
- **A fix all the way: ticket 1018, "Valid input is refused on /contact".** The probes saw it on 7 October at 07:53:35 ("Sending a valid message answered 422"), and triage opened the ticket then. It waited for LINE_TAKE, which #238 raised to 7. The line took it by its own rule at 20:24:44, the oldest open ticket of the highest severity, and nobody chose it.

  | Stage | Ended at | |
  |---|---|---|
  | Plan | 20:25:14 | the spec |
  | Build | 20:26:22 | the app's #61 pushed, under issue #60 |
  | Gates, round 1 | 20:29:11 | lint, types and tests failed; back to the coder |
  | Build, round 2 | 20:29:51 | pushed |
  | Gates, round 2 | 20:32:25 | every required check passed |
  | Review | 20:32:49 | approved |
  | Waiting for Martin's merge | 20:33:34 | the summary written |
  | Martin's merge | 20:37:39 | held at Release for the deploy |
  | Martin's deploy merge | 20:42:35 | the app's #63 |
  | `release.started` | 20:45:14 | |
  | `canary.stepped`, 25% | 20:48:44 | passed |
  | `canary.stepped`, 50%, and `release.promoted` | 20:52:14 | passed |
  | `verification.finished`, cleared | 20:52:24 | its probe check passed twice |
  | `work-item.closed`, verified | 20:52:42 | the App closed issue #60 |

  From taken to waiting for the merge took 8 minutes 50 seconds; from Martin's merge to verified, 15 minutes 3 seconds; from his deploy merge to verified, 10 minutes 7 seconds; and from taken to verified, 27 minutes 58 seconds. From the signal to verified took about five and a half days, nearly all of it waiting for LINE_TAKE. The scoreboard ticked up: verified fixed went to 2.
- **A bad change, unattended.** The line took ticket 1027, "A wrong result on /search" (issue #65), by its own rule at 21:25:33, with LINE_TAKE at 8 (#239). The planner's first result did not fit its schema (it named a page with a query) and its step ran again, done at 21:26:30. The reviewer asked for changes once, and approved the second round at 21:35:52; the summary was written at 21:36:38. Its fix is the app's #66, which the reviewer's own answered thread kept from merging until Martin resolved it (#240). Then a drill on the app's `main` (#64), the lock from Part A's bad release again. #66 merged at 21:41:54, the drill at 21:58:18, and the deploy that carried both (#67, 6f2896a) at 22:02:39. The release started at 22:05:00 and rolled back at 22:08:00, at the 25% step, with nobody touching it: latency failed twice, against a failure limit of one. 1027 stayed at Release. The rollback's signal, `slow-response` on `*`, repeated ticket 1034, which Part B's rollback had opened and which was still open, so triage counted it there rather than opening another.
- **The rollback's ticket, fixed.** #241 raised LINE_TAKE to 9 and set LINE_ONLY to 1034, at 22:24:26; the line took 1034 a second later. The planner ran from 22:24:40 to 22:24:59, the coder from 22:25:09 to 22:25:57, the reviewer approved at 22:30:17, and the summary was written at 22:31:04, in one round. Its fix is the app's #69. #242 took LINE_ONLY away again, so the deploy would say what it carries. Martin merged #69 at 22:39:27 and its deploy (#70, 94e8cce) at 22:44:06. Release 94e8cce carried 1027 and 1034: it started at 22:47:15, passed 25% at 22:50:45, and passed 50% and promoted at 22:53:46. 1034 cleared at once, by the canary's latency measure passing at the promoted release's last step, and closed at 22:53:58; 1027 cleared by its probe check at 22:53:56, and closed at 22:54:01. Verified fixed went to 3.
- **Watched, and approved.** Martin watched both runs in the console, on a laptop and a phone, and approved them against `INTENT.md`: "I very much approve both runs against INTENT.md. I watched every little thing." Of the Canary panel: "worked flawlessly".
- **The scoreboard** (`factory scoreboard --print`, after the runs). Found 14 of 24; verified fixed 3 of 24; median time from a ticket's first signal to its verified fix 6,648.7 minutes, about four and a half days, since the tickets it counts waited days to be taken; and false positives 20 of 36 tickets. Tickets 1034 and 1035 came from Martin's drills, not seeded defects, and drills are not in the answer key, so the scoreboard counts both as false positives, though both were verified. Spec 10.2 asks for 60% found and 40% verified fixed: found is at 58%, and verified fixed at 13%, with most tickets not yet taken.
- **The console's budget.** The Canary panel, the sheet's new section and the timeline's marks raised the console's bundle budget from 120 kB of script and 11.5 kB of styles to 128.2 kB and 12.4 kB, in commits of their own in #232, #234 and #237. Preact won it back: the console runs on it, and the script's budget is 76.2 kB (#236).
- **Open question 3,** how an injected defect is seen within 5 minutes, is answered by these measurements and is gone from `OPEN-QUESTIONS.md`; the injector (milestone 9) is held to the spec's target. The runs measured the part after the deploy merge. The drill's release started 2 minutes 21 seconds after its deploy merged, and its rollback, which is its signal, came 3 minutes after that: 5 minutes 21 seconds from the deploy merge, and 9 minutes 42 seconds from the drill's own merge, with Martin's deploy merge between. Part B's log watcher saw its drill under two minutes after the release started. A defect the canary does not fail is seen only once its release is promoted, about 7 minutes after it starts, when the senses run again on the new version.

## Retrospective

### Part A

Written as Part A's pull requests (#169 to #172, #174, #175 and #177, and the app's #34) merged, with the fixes its runs needed and the two pull requests that turned admission on (#185, #186). What Part A taught, and where each lesson now lives.

**Learned on the cluster**

- GHCR has no referrers API: cosign lists an image's bundles under a `sha256-<digest>` tag whose index carries no annotations, so the deploy watch, which read the bundle's kind from those, found no signature at all. It reads the kind from the bundle's own manifest, or the statement inside it, when the index does not say (#181).
- To verify a signature, cosign fetches and parses every bundle attached to an image, attestations included, and `factory-browser`'s SBOM attestations are about 23 MB per platform. Kyverno's admission controller has 1 Gi, and admission checks the signature only; the deploy pull requests' checks verify the SBOM, where parsing it is cheap (#184, ADR 0010).
- Sigstore's TUF client downloads into `/tmp`, which a read-only root filesystem does not have, so the GitHub worker has a writable `/tmp` of its own (#187).

**For Part B**

- An abort and a failed analysis look the same on the Rollout: task 11 says how the signal tells them apart.
- Traefik counts requests per Service, not per version, and the errors and latency are the app's own figures: both are under the risks.

**Left open:** the reel's render-count test is flaky (#182); egress by host name waits for milestone 10 (#176).

### Part B

Written as Part B's pull requests (#191 to #196, #201, #202, #205 and #206) merged, with the fix its runs needed (#212). What Part B taught, and what Part C starts from.

**Learned on the cluster**

- A migration races the image that reads it. Migration 0008 moved 1001 and 1006 to Release, and the line image still running set them back to ended. A migration that moves work items must reach the cluster with, or after, the image that understands them.
- The test-integrity gate holds a fix against its own revert: a revert deletes the fix's tests, and the gate refuses that. So a drill that makes a signal persist has to slip past the fix's tests, the way a regression would.
- A drill that only logs an error, and still answers 200, drives Verify and reopening deterministically. The gates and the canary do not see it, and the log watcher's ticket opened under two minutes after the release started.
- A release that rolls back before its first step is measured has no `canary.stepped`: its `release.rolled-back` and the series it carries are the whole story.
- The app labels `http_route` with the raw path, so the routes where the canary did worse are named by path.

**For Part C**

- The console: a return stays on the line for a day after its work item has moved on (#209); a sheet's replay scrubber is unreadable for a work item that goes round twice (#210); canary pictures box another sense's finding, and the console draws the boxes out of place (#211). #212 made a verified work item's sheet show the ticket's page on the fixed version, and each hold at Release and Verify say what it waits for.
- The journeys' figures are empty in `canary.stepped`, so the Canary panel has nothing to show for them yet.
- Canary pictures are never deleted (#198), a release of an image promoted before is not recorded (#199), and the factory's own requests count in the canary's errors and latency (#200).
- LINE_TAKE is 6, and all six are taken, so the line takes nothing new until it is raised. 1035's third fix (the app's #54) is merged, and its verification comes after this record. `src/greeting.ts`, from the second drill, has been unused in the app since #50.

**Left open:** the reel's render-count test is flaky (#182); egress by host name waits for milestone 10 (#176); a broken Mermaid diagram reaches a pull request's description (#197); and #198, #199, #200, #209, #210 and #211, above.

### Part C

Written as Part C's pull requests (#218 to #225, #230 to #234 and #237, the app's #58 and the private repository's #6) merged, with the deploys and the runs' changes to the line's limits. What Part C taught, and what is left.

**Learned on the cluster**

- The fix took 28 minutes from taken to verified, and the ticket waited five and a half days to be taken. LINE_TAKE, not the line, sets how long a ticket waits, and the median time to a fix measures that wait more than the fix.
- The scoreboard cannot tell a drill from a defect the factory invented. A drill's ticket matches no entry, so 1034 and 1035, both verified, count as false positives. The results say so; the figure does not.
- A signal that repeats an open ticket is counted in the inbox and appends nothing to the ticket. The rollback in the second run reached 1034, and nothing on 1034 says so: the console shows the rollback on the line and 1034 unchanged.
- `main` needs every conversation resolved before a merge, and the reviewer leaves its own answered findings open, so a fix it approved could not merge until Martin resolved the thread by hand (#240).
- A release that carries a fix and a drill rolls back with both, as the plan said it would; the fix waited at Release and went out with the drill's fix, in one release, and each ticket cleared by its own sense.
- The planner's first result can miss its schema on a page with a query; running the step again was enough.
- Argo Rollouts' controller may read every Secret in the cluster, by its chart. It is the one exception `make egress` names for the scoreboard's.

**What's left.** Open: egress by host name waits for milestone 10 (#176); a broken Mermaid diagram reaches a pull request's description (#197); a release of an image promoted before is not recorded (#199); a ticket's own box can be crowded off its page's pictures (#235); and the reviewer's open threads (#240). Filed from Part C's runs: the scoreboard's loop has no test (#244); during a canary the senses' requests count in the baseline's figures only (#245); an aborted release is inferred, where a `release.aborted` event would record it (#246, milestone 8); a signal counted into an open ticket leaves no trace on it (#247); optionally, found moving only when enough tickets opened in its window (#248), and the scoreboard reaching Postgres with no DNS (#249); and the reel's render-count test still flakes (#250).

The console's gaps against its design, found while writing this, are fixed in #251: a fix waiting for the deploy, in Release's panel row, and on its card and sheet once the release that carried it has rolled back; a rollback with no step measured leaving out what the analysis saw against its limit; and a phone dropping a measure's error message. The mockup's failed measures said more than the event carries, so #251 cuts them back to what the console draws; giving both versions' figures, and how long the measure failed, is #252 (milestone 8).
