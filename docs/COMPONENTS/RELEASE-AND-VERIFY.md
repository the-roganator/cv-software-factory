# Release and Verify

The line after the merge: which release ships a fix, and whether the defect has gone from production. Part of the [factory plane](README.md#factory-plane).

- **v1:** part of [the line](ORCHESTRATOR.md), as pure functions of the events and what it reads (`release/watch.ts`, `line/verify.ts`), with the reads and appends in `line/release.ts` and `line/worker.ts`.
- **v1:** Martin's controls of a release in flight (promote, pause, resume, abort and retry) through the [admin service](ADMIN-SERVICE.md#the-canarys-controls); the line records what the Rollout then does.
- **v1:** an improvement behind its feature flag judged at each stage Martin sets it at, in a pass of the line's own (`line/flags.ts`): [Verify by variant](#verify-by-variant).

```mermaid
flowchart LR
  merged([The fix merges]) -- "not a dry run's" --> held[Held at Release: deploy]
  held -- the deploy pull request merges --> started[release.started]
  started --> measuring[canary.measuring, per look]
  measuring --> stepped[canary.stepped, per step]
  stepped --> promoted[release.promoted]
  started -- "an analysis fails" --> rolledback[release.rolled-back]
  started -- "an analysis cannot judge it" --> errored[release.errored]
  started -- "Martin aborts it" --> aborted[release.aborted]
  started -- "judged bad, auto-rollback off" --> paused[Held at Release: canary]
  paused -- "Martin promotes it fully" --> promoted
  paused -- "Martin aborts it" --> rolledback
  paused -- "Stop the line" --> aborted
  rolledback -- rollback signals --> triage([Triage])
  rolledback --> held
  errored --> held
  aborted --> held
  held -- "Martin retries it" --> started
  promoted --> verify[Verify]
  verify -- cleared --> closed([Issue closed, work item verified])
  verify -- persists, first time --> plan([Back to Plan])
  verify -- "persists again, or can't tell for 24 hours" --> hold[Held at Verify for Martin]
```

## Release

- **The hold.** Martin's merge clears any hold the change had, and the work item holds at Release (cause `deploy`, for his approval, so Needs you lists it) until a release that carries it starts. He settles it by merging the app's deploy pull request, not by answering, and `release.started` ends the hold by itself. That pull request is his to merge only once it is open and its checks have passed ([the deploy pull request's state](#the-deploy-pull-requests-state)); until then the console says what the hold waits for.
- **A rollback.** A release that rolls back holds it again, for the next release that carries it, or Martin's retry, which starts the same release again, judged afresh.
- **A canary paused for Martin.** With auto-rollback off, a canary whose errors or latency the analysis judges bad is paused rather than rolled back ([progressive delivery](PROGRESSIVE-DELIVERY.md#auto-rollback)): the line holds each work item it carries (cause `canary`), which takes no answer of the holds'. He promotes it fully or aborts it from the Canary panel, and the release's end, whatever it is, ends the hold. Switching auto-rollback on again does not: the canary stays paused for him. His abort is a rollback (`release.rolled-back` by `martin`): it fails Release as any rollback does, and sends triage what the analysis judged bad. Stop the line's abort stays an abort. A release that carries no work item has none to hold: its events, on the line, say it is paused.
- **An analysis error.** A release whose analysis could not judge it holds it again too, as an abort does: Martin's retry starts the same release again, or the next release that carries it ends the hold.
- **An abort.** A release Martin aborts holds it again too, with the hold's reason saying whether Stop the line aborted it or he did. His retry starts the same release again, which ends the hold as any start does; otherwise the next release that carries it does.
- **A dry run's merge**, which no deploy pull request can carry, is not held: it waits at Release for the dry run's release, and Needs you never lists it ([Dry run](#dry-run)).

### What a deploy carries

Once a minute the line tells the [GitHub worker](GITHUB-WORKER.md#carries) what the open deploy pull request carries, and the worker writes it into the pull request.

`carried`, in `line/release.ts`, works it out. A deploy carries every merged work item, not closed or reopened since, whose latest merge commit is between two commits, read through the worker's `commits`:

- the commit the stable version runs: the last promoted release's, or else the pinned one;
- the one proposed.

For a reopened work item, only a merge after its reopening counts.

The same function decides what a release carries, so while a release is in its canary the deploy pull request lists its work items too, until it is promoted.

### The deploy pull request's state

The App opens the deploy pull request once main has a newer signed build ([deploys](GITHUB-WORKER.md#deploys)), so it lags a merge by the build and its signing, and a newer build moves the same pull request to a new head. In the same pass, `line/deploy.ts` records, on each work item held for a deploy that it carries, where that pull request stands for it (`deploy.changed`):

| `state` | When |
| --- | --- |
| `checking` | It is open, and a required check on its head has not finished, or none has started: on a new head, they start again |
| `passed` | Every required check on its head finished, and none failed: a skipped check, such as the browser tests a deploy pull request skips, is no failure. It now waits for Martin |
| `failed` | A required check on its head failed, named in `failed` |
| `merged` | It merged: the release starts once Argo CD syncs, and ends the hold |
| `closed` | It was closed unmerged: the next build's carries the work item |

- The checks are judged as the gates are (`judge` in `line/gates.ts`), against what main's rulesets require, through the GitHub worker's `pullRequest`, `checkRuns` and `requiredChecks`.
- A work item's record is the latest `deploy.changed` since its hold started, so a hold that starts again (after a rollback) waits for a deploy pull request of its own. A state that differs from it is appended, so the decision is the store's, and a line that starts again appends nothing twice.
- A pull request recorded for a work item that is no longer the open proposal is read by its number: merged or closed is recorded only as GitHub says, never because the GitHub worker, just restarted, knows no proposal yet.
- Once the pull request that carries it has merged, a newer build's is not followed: until Argo CD syncs, `carried` still counts the fix from the version the app runs, and the newer one is not its deploy.
- A dry run's deploy pull request, which GitHub never had (`DRY_RUN_NUMBERS_FROM` up), is never recorded.
- A read that fails leaves that work item to the next pass.

## The release watch

`RELEASE_ROLLOUT` (`<namespace>/<name>`) turns it on; unset, there is none. Every 30 seconds it reads the app's Rollout and its AnalysisRuns, and it changes nothing. It goes on while the line is stopped, so the abort Stop the line makes is recorded as it happens; a dry run's releases wait for the line to start.

- A Role in `website` lets the line get, list and watch Rollouts and AnalysisRuns, and list pods, and nothing else there (`deploy/base/analysis/line-reads-release.yaml`). `release-fences.test.ts` holds it to exactly that. The line also compares the Rollout's pause and full promotion with Martin's controls, by the same Role ([alerting](ALERTING.md#changes-no-event-records)).
- A release is named by its canary's pod-template hash and the Rollout's revision, `<hash>-<revision>`. Argo Rollouts gives the same pod template the same hash and counts the revision up on every new rollout, so pinning an image released before (to go back to it) starts a release of its own, with its own runs. A retry keeps the revision, and is the same release. A release recorded before the revision is named by its hash alone, and read as it was then, until it ends: a later rollout of its hash is a release of its own.
- The line reads the revision only once the Rollout's status has caught up with its spec (`observedGeneration`): Argo Rollouts writes the next revision before the status that names the next version's hash.
- The stable version is the last release of its hash the line recorded that was promoted, or is still in flight: a Rollout goes back only to a version it promoted. A Rollout sent back to its stable version with no canary, as after a rollback, takes the next revision without releasing anything, and the line records nothing of it. An image promoted before and released again while the line was not looking is at a revision of its own too, and is found live: a release leaves runs of its hash at its revision, and a Rollout sent back leaves none. Argo Rollouts keeps only the latest runs (the app's Rollout sets no history limit, so five successful and five unsuccessful, of which a release makes three), so where there are none the store says, by the last release the line recorded as promoted, dry runs aside: sent back, the Rollout runs that release; released again, an image promoted before it. A line that also missed a rollback reads it wrong.
- A release's version is the image's commit, which the GitHub worker reads from GHCR with its signature (`imageRevision`, `imageSigned`), since the line cannot reach GHCR.
- A release carries every merged work item whose latest merge commit is in its image and not in the one before. Each gets the release's events, with actor `rollouts`. A release that carries none has them on the line itself.

### Its events

| Event | When | What it holds |
|---|---|---|
| `release.started` | The canary's pods take traffic (or with `admitted: false` when its pods are refused), recorded only once the stable version has a record of its own | The canary's steps as the Rollout has them then: each weight set, how long it pauses there and whether a step analysis judges it (null when a pause cannot be read). The console draws the steps from the event and copies nothing of the app's Rollout |
| `canary.measuring` | Each look of the background analysis lands, while the release is in flight: errors and latency about every minute, the journeys every three | The measures the look took, each with that measurement's phase, value, limit, words and end; when it was taken (`at`, the measurement's end); the canary's weight then; and each version's figures at that time, as for a step. Judges no step |
| `canary.stepped` | Each step's analysis ends | The analysis's own measures (each one's phase, value, limit and words), each version's requests, error rate and p99 from Prometheus (`PROMETHEUS_URL`), by pod-template hash, and how many of the journeys' checks passed on each, of how many ran, from the step's journeys Job |
| `release.promoted` | The release becomes the stable version | |
| `release.rolled-back` | The Rollout is aborted and a run of the release's latest attempt failed; or Martin aborted it while a run of the attempt was Inconclusive on a measure, and no run was made after it ended (judged bad, with auto-rollback off) | When Argo Rollouts acted on the abort (`abortedAt`, when the Rollout says). Each failed measure, or in Martin's, each measure judged inconclusive in the attempt's runs, with how many of its looks were, how many of its run's looks failed (Argo Rollouts' count, across the run), and, for errors and latency, its series from the release's start to the failure; and who rolled it back (`by`): the `analysis`, by itself, or `martin`, aborting a canary the analysis judged bad and paused for him with auto-rollback off ([progressive delivery](PROGRESSIVE-DELIVERY.md#auto-rollback)) |
| `release.errored` | The Rollout is aborted, Argo Rollouts has acted on it (`status.abortedAt`), no run of the release's latest attempt failed, and one ended in Error in the minute before | The weight the canary had reached, the analysis's words, each measure it could not take, and when Argo Rollouts acted on it. Actor `rollouts` |
| `release.aborted` | The Rollout is aborted, Argo Rollouts has acted on it (`status.abortedAt`), and no run of the release's latest attempt failed or ended in Error | When Argo Rollouts acted on it, and who aborted it (`by`): `stop` for Stop the line, `martin` for his own, from the console or by hand. Actor `martin` |

A figure or series Prometheus did not give is left out. The journeys' counts are null when the step's Job or its pod cannot be read, is gone, has not ended, or wrote no counts; the step's other figures are kept either way.

- **Who aborted it.** Martin's abort terminates the runs, which fails none, and is no signal. To Argo Rollouts, his abort from the Canary panel, Stop the line's (from the console's header, by the admin service, or `scripts/abort-canaries.sh`) and his by hand are the same patch of the Rollout's status, so the line says which, in this order:
  - from the control one of his roles recorded of this release, `release.controlled` with `abort`, within the minute before the abort ([admin service](ADMIN-SERVICE.md#the-canarys-controls)): `stop` when it says it came with the console's Stop the line (`stop: true`), `martin` when it came from the Canary panel. The control says so, not the time. The admin service records it just after its patch, so an abort less than fifteen seconds old that no control has claimed waits a pass;
  - `stop` when the last `line.started` or `line.stopped` before the abort is a stop recorded within the minute before it: `make stop-the-line` records the stop, then aborts with a script that records nothing, and the console's stop records no control for a release the line had not recorded yet;
  - `martin` otherwise: an abort by hand, with his own credentials, the one other way a Rollout is aborted.

  The command line's Stop the line is still told by time, so when the stop cannot be recorded (the store is down, and the make target aborts anyway) the abort reads as Martin's, and an abort he makes by hand within the minute after a stop reads as the stop's. Argo Rollouts keeps the abort's time to the second, cut short, so a control or a stop recorded within the second after it counts as before it. A retry and a second abort between two reads are both recorded, by the abort's later time.
- **Where it was.** An abort sends the Rollout back to its first step, so the event holds no weight: the console reads the canary's weight then from the release's steps, as it reads one in flight.
- **Each look.** The background analysis takes its measures throughout the release, and Argo Rollouts keeps each run's latest measurements. The line records those of the release's newest background run that ended and that no look has recorded: each attempt makes a run of its own, so an earlier attempt's looks are never a retry's. Until a retry's run is made, the newest is the run the abort ended, which Argo Rollouts terminated (or which failed or erred, and aborted the release itself): while the release is in flight, that run is an earlier attempt's, and what it wrote after the line recorded the abort, such as the journeys' measurement the abort terminated, is no look. Each measure of a look says when it ended, and a measurement is known by its measure and that time, not by a time the looks have reached: Argo Rollouts keeps the time to the second, and one written a pass after a look can have ended in the same second as it. Reading the same runs again records nothing, and a line that was down records the looks it missed, in order among the steps. Measurements that ended within five seconds of each other are one look, and a measure taken twice in that time two: Argo Rollouts takes the measures that are due together and writes them in one status, and the journeys, a Job, end on their own. A line that reads between two writes a moment apart records the second as a look of its own, a pass later; nothing is lost or recorded twice. A measurement that has not ended is no look yet. The Rollout says only where the canary is now, so a look's weight is read from the step runs, as a rollback's is: the step of the last made in the look's attempt before it (one made a few seconds before the attempt's background run and still running then, as the two can be made in one pass, among them), or past it once that one had passed, or the first before any. A dry run measures nothing, and a release found live was not seen, so neither has looks.
- **Where it rolled back.** `release.rolled-back` holds the weight of the step that failed: a step run's own, by its step index. The background analysis's run has no step, and the abort has already sent the Rollout back to its first, so its weight is read from the step runs of the release's latest attempt: the step after the last whose analysis passed, or the step of one that did not pass, or the first before any; or further, the step of a run made after that one, which the abort terminated. Weights are the Rollout's, by step index, as each step's are.
- **A canary judged bad, with auto-rollback off.** Argo Rollouts calls a measure Inconclusive when its figure meets neither its success nor its failure condition, which the templates make so of a bad figure only while auto-rollback is off, ends the run Inconclusive past its `inconclusiveLimit`, and pauses the Rollout, `pauseConditions` naming `InconclusiveAnalysisRun`. The step or look that judged it is recorded as ever (`was inconclusive`). Once the Rollout says it paused for that, and no run of the attempt was made after that Inconclusive run ended (a run made after it measures the canary again, as when it was resumed past it by hand; one made before, such as a step's still measuring when the background analysis paused it, may pass and takes nothing from the verdict; a run an abort or a promotion terminated judged nothing), the line appends `hold.started` (cause `canary`, stage `release`, naming the release) on each work item the release carries, once in the attempt: what it judged bad, by how much, in the analysis's words. When the Rollout is then aborted, by Martin (his control, or by hand) and with that verdict still standing, it records `release.rolled-back` with `by: martin`, at the weight the canary had reached, the run's words as its reason, and the inconclusive measures, their series read before the line knows whose the abort was; by Stop the line, `release.aborted` with `by: stop`. A release retried after either is judged afresh: its earlier attempts' runs hold nothing of it, and a pause of the new attempt holds its work items again.
- **An analysis that ends in Error** aborts the Rollout itself: the analysis could not judge (Prometheus did not answer, say), and nobody stopped it. A run of the latest attempt that ended in Error within the minute before the abort made it, and the line records `release.errored`, at the weight a rollback would have, with no signal: nothing failed. The release stays stopped until Martin retries it or a later release carries its work items. An abort he makes by hand within that minute, before Argo Rollouts acted on the Error, reads as the Error's: the Rollout keeps only one time for both, so the release is held for him either way, and his retry carries it on the same way.

### Found live

A stable version with no record and nothing in flight was released before the watch saw it. The line records `release.started` (with no steps: nobody saw them) and `release.promoted` for it, with actor `factory` and `watched: false`, on every merged work item no release has carried whose merge commit it holds, or on the line.

### Rollback signals

Each measure that failed a release the line recorded and watched start is a signal from the `canary` sense, named by the run and the measure so it is sent once (`release/signals.ts`).

- The measures are errors, latency and the journeys. Too few requests is no signal.
- A release found live sends none.
- A retried release's earlier attempts' failed runs are its own.
- Martin's rollback of a canary judged bad sends each measure the analysis judged inconclusive in the runs of the attempt he aborted, as a failed one would be sent, with the analysis's words verbatim on the measure and in the summary ("judged bad and rolled back by Martin"). An attempt promoted, or stopped with the line, sends nothing of what it judged.

| Measure | Signal class | Route |
|---|---|---|
| Errors | `server-error` | The one route where the canary did worse than its baseline (from Prometheus, per route); `*` when it was more than one, or Prometheus found none |
| Latency | `slow-response` | As for errors |
| Journeys | The first failing check's class | Its route when every failing check shares one; otherwise `*` |

- **On an open ticket.** A rollback whose signal has an open ticket's fingerprint joins that ticket as its evidence, naming the release ([triage](TRIAGE.md#matching-an-open-ticket)); the Canary panel says triage added it to that ticket.
- **A canary's `*`** means routes the analysis could not narrow to one, and its ticket is titled "&lt;class&gt; in a canary release". Any other sense's `*` is every page.
- **The journeys' checks.** The journeys Job writes the checks that regressed, and how many passed of how many ran on each version, to its container's termination message (`COMPARISON_FILE`), which the line reads from the Job's pod. When that is lost, the signal is `wrong-result` on `*`.
- **Not yet readable.** A measure whose routes or pod cannot be read yet, or whose pod's container has no status yet, waits for the next pass.

## Verify

A promoted release moves its work items to Verify. Every 5 minutes, in the background, the line looks at the version the stable Service runs (the release that carried the fix, or a later one) by the sense that saw the ticket's defect, from the ticket's first signal (ADR 0011):

| First signal from | How it is looked at | Cleared when | Persists when |
|---|---|---|---|
| A probe or crawler check | The check runs again on the [probes worker](PROBES-AND-CRAWLER.md#verify) (`PROBES_URL`, their verify port), at most four runs | It passes twice in a row | It fails twice in a row |
| An alert | Its expression, over the new version's requests to the route (`service_version`) | It stays inside the objective for 30 minutes with enough requests | It is outside for as long as the alert waits to fire |
| A log pattern | Loki (`LOKI_URL`) | The new version logs none of it for 30 minutes with enough requests | It logs any |
| A missing log or wrong metrics | The log watcher's agreement check, over the route's requests in the metrics, the log and the traces (Prometheus, Loki, and Tempo at `TEMPO_URL`), on the new version, in the watcher's five-minute windows over the last 30 minutes, the last ending four minutes ago, none before the promotion | The three agree on the route, with enough requests, for 30 minutes; on `*`, the log counts the requests again, or for wrong metrics the three agree on every route with enough requests | The record the ticket named is the odd one out again on any of the route's paths; on `*`, the log is silent for every route, or for wrong metrics they are wrong on any route judged |
| The canary | The release's own analysis | The release was promoted with that measure passing at its last step | — (holds for Martin when the measure did not pass there, or the release was found live, which no analysis judged) |
| A visitor's report or the planner alone | — | — (holds for Martin's approval) | — |

The windows and counts are `policy/release.ts`'s `verify`.

- **The agreement check's routes.** A path the log does not place (a missing log places none) counts towards the route whose template it fits, so a page still unlogged keeps its route's ticket open; a path the log gave a route of its own in the last day stays that route's. A path or route is judged only with enough requests, persisting as clearing. On `*`, a route the log still leaves out of an otherwise full log is not the silent log's: the watcher finds it as a ticket of its own. A route whose metrics are still wrong is the `*` wrong metrics' ticket, though others agree, since triage gives that ticket each route's wrong-metric signals: it persists.
- **A gap in the metrics.** A path whose series had a gap in one of the windows (no sample at its start, some in the day before, as the watcher counts it) came back with its running total, which would read as wrong metrics or a missing log either way, so it is left out, as the watcher leaves it out. The route's other paths can still show the ticket persists; it clears only once none of its paths had a gap, and until then Verify waits ("the metrics had a gap"). On `*` the other routes are judged, and Verify waits only when too few requests are left without the gap.
- **Without Tempo.** A missing log is judged on the metrics and the log alone, as the watcher judges it when the traces are late; wrong metrics wait, since only the traces say the metrics are the odd one out.
- **Can't tell yet.** A look that cannot tell (too little traffic, a check that could not finish, a sense the line has no address for) looks again later, and holds after 24 hours with its reason.
- **Another release.** A look during which another release promoted counts for nothing.

### Outcomes

- **Cleared** appends `verification.finished`, has the App close the ticket's issue as completed with a comment saying what cleared it, and closes the work item as `verified`.
- **Persists** appends `verification.finished` too, and sends the work item back to Plan once, for a fresh pass whose planner is told what persisted. A second persisting holds (cause `verify`).
- **Martin's answer to a Verify hold:** approving closes the work item as verified, with his words; answering sends it back to Plan; rejecting closes it.

### Held and waiting work items

A work item held before its merge, or waiting for overlapping work ([a spec that overlaps](ORCHESTRATOR.md#a-spec-that-overlaps)), is carried by no release, so Verify never looks at it. The line looks at it the same way instead (`signal.rechecked`), at the version the stable Service runs, which did not carry its fix:

- **When.** After each real release is promoted, once a release: the latest real promotion on any work item or on the line, so a release that carries none of the line's work (Martin's own commit, a dependency update) counts too. Once as a hold or a wait starts, too, so a release just before it is not missed. And once as the work a waiting work item waits on is verified or closed.
- **Not when** a signal of the ticket has been seen on that version (triage records each sense's first in each version), which says the defect is there already; nor for a ticket only a visitor's report or the planner saw, which no sense can look at; nor for triage's holds; nor once a release of the work item's own fix is out, which is Verify's to look at; nor later than 24 hours after the release, or the start of the hold or wait, whichever is later.
- **One at a time** across the line, beside Verify's looks, under Verify's lease. It takes no pictures: there is no fix to compare.
- **It records** what it found (`cleared`, `persists`, or `unsure` with why), the release, its version and the version before, the version the ticket's signal was last seen on (`since`), and the work items carried by every real release promoted since that version became the stable one, or, for one the line never saw promoted, since the first release that replaced it (so a signal triage records late, on the version before a promotion, does not hide that promotion), up to the one looked at, each with the pull request it merged: those are what it credits. Only when they carried no work item does it say they carried none of the factory's fixes. A sense that cannot tell is asked again every 5 minutes, and after 24 hours nothing is recorded for that release; at the end of a wait, it is recorded as `unsure`, and the work item goes on to Build, as it does when no release of the app has been recorded. A look during which another release promoted counts for nothing.
- **Cleared**, a hold the line made itself, or a waiting work item, closes as verified: the issue as completed, and an open pull request unmerged, each with a comment saying what cleared it and the fixes released since its signal, then `work-item.closed`. A hold that waits on Martin's judgement only records the look, and closing its pull request then closes it as verified ([holds](ORCHESTRATOR.md#a-held-work-item-whose-defect-went-another-way)).

### Open tickets a release may have fixed

One fix can clear more than its own ticket: a change that gives the home page's images alt text gives them to the product pages too. The line looks at an open ticket the same way (`signal.rechecked`), so that it closes on the fix that cleared it rather than waiting for the planner to find nothing:

- **As the line takes a ticket** (`for: take`), before its issue opens and the planner starts, when its signal was last seen on a version before the one the stable Service runs. Not for a ticket planned before, reopened, held or waiting, nor once its issue is open or a step of it has failed. A sense that cannot tell is recorded as `unsure` at once, so a sense that is down holds up no ticket; `persists` or `unsure`, the ticket goes on to Plan, and that release is not looked at for it again.
- **As Verify clears a fix** (`for: fix`), at each open ticket the line has not taken whose first signal's sense and symptom are the fix's own, up to ten, oldest first, whose signal was last seen on a version before the one Verify looked at, one at a time, and no other look again starts meanwhile. Only what cleared or persists is recorded; a ticket the sense could not tell of is looked at as it is taken. Not with Just one, which leaves every other work item as it is.
- **Cleared**, the ticket closes as verified by itself, with no issue opened and nothing spent on a model. Its `work-item.closed` says what cleared it and names the fixes released since its signal and their pull requests ("with the fix of work item #1009 (pull request #120)"); nothing is added to the fixing work item's own events. A ticket closed as the line took it counts as one the line took, under The next few, and the line takes the next at once.
- Events are never rewritten: tickets closed before this look, as #1010 and #1011 were with no change, stay as they closed.

### Pictures

The verification, and either Verify hold, names up to twelve pages the probes worker compared while the release ran as a canary ([pictures](PROBES-AND-CRAWLER.md#pictures)):

- the ticket's own page first, then those that changed most;
- each page that is not the ticket's own but another work item's the release carried naming that work item, so a change meant for another reads as its;
- with their screenshots as the event's artifacts;
- each keeping only the boxes of the ticket's own check on its own page, so a ticket whose sense boxes nothing (the logs, the metrics, the canary) has none.

The line's event writer vouches for those by the picture index (`IndexedArtifacts`), and for no other artifact.

## Verify by variant

An improvement ships behind its feature flag, off, and Martin widens the flag a stage at a time from the console ([the stages](FEATURE-FLAGS.md#the-stages)). Verify judges its work item at each stage. The line carries an improvement to its release as it carries a fix, and once a release that carries it is promoted it hands it over, with no sense asked to look ([an improvement](ORCHESTRATOR.md#an-improvement)): its row on the line ends, and its work item stays open. From its spec on, the line judges it in a pass of its own, driven by the flags' state, not by the ticket machine (`line/flags.ts`).

- **The pass.** About every thirty seconds (`flagsEveryMs`), beside the release watch, while the line runs, and not while it is stopped. Live and in a dry run alike, since a flag is real in a dry run too, and whether or not agents take new work; with `LINE_MODE` off, as the line moves nothing, it closes nothing either. It takes no lease, and appends only what the flags' events call for, which the next pass reads. With [just one work item](#with-just-one-work-item), it acts on that work item alone.
- **What it reads.** `flagEvents` in the store, the reader the [admin service](ADMIN-SERVICE.md#the-flags-stages) judges a move by: Martin's `flag.staged` from his roles alone, and the revision of the flag set his latest move of any flag wrote; the line's own judgements of each flag (`flag.compared`, `flag.checked`), from its role alone; and which improvement's latest spec, as the line's role recorded it, names each flag; never a sample's. It names a flag, and the pages its spec names, only for an improvement Martin asked for: its opening and his request both appended by one of his roles. Then, for each work item a flag was last staged on, and each improvement whose spec names a flag at Off, whether it is such an improvement, not a sample, and still open. A flag staged on any other work item is left out, and the line logs that once. It reads neither `flags` nor flagd: Martin's events say where each flag stands.
- **What it decides.** `flagsNext`, a pure function of what it read and the time: what the pass does for each flag: close an improvement whose flag was turned off ([Off](#off)), or that is on for everyone ([Everyone](#everyone)), check it with the probes at Off, Checks or Preview ([the probes' checks](#the-probes-checks)), or compare a flag at Share ([Share](#share)).

### Off

A flag Martin turned off, at any stage, closes the improvement it was staged on as turned off: `work-item.closed`, outcome `turned-off`, by the line, with his reason from the move (which Off requires). First its issue closes as not planned, with a comment giving his reason as its public view has it; in a dry run the GitHub worker records that, as it records any other action. An issue GitHub no longer has, or the App may no longer change, is left; any other failure leaves the work item open, and the next pass tries again, saying nothing twice. It is no rollback: the code stays in the app, off, and the release that shipped it stands. It closes once, as the work item is then closed; a close the store refuses (another got there first) is logged and leaves the rest of the pass to go on. A flag turned off from Everyone may still go straight back on, recorded on its closed work item, narrowed, compared and turned off again, which closes nothing more. One turned off from any lower stage stays off from Martin's move on, whenever the pass gets to the close: the admin service refuses widening it again on that work item, though the same flag named by a later improvement's spec widens afresh there. An improvement already closed as verified at [Everyone](#everyone) closes nothing more when its flag is turned off, and stays verified.

### Everyone

A flag Martin widened to Everyone closes the improvement it was staged on as verified: `work-item.closed`, outcome `verified`, by the line, once the app has had the minute it has to hold his move (`FLAGS_HELD`, the same minute a comparison at Share waits from). First its issue closes as completed, with a comment saying the flag is on for every visitor and that turning it off is still one move in the console, with the same retries as at [Off](#off). Everyone is reached only once Verify's comparison of the flag at Share has passed ([the flags' stages](ADMIN-SERVICE.md#the-flags-stages)), so the close judges nothing of its own. The line drops it when Martin has moved the flag again since the pass read it, and the next pass decides afresh; once the issue has closed, the close is recorded, as an Off after it closes nothing more. An improvement whose latest pull request is a dry run's never reached the app, so it is not verified: it stays open, and the line closes it with no change once it runs live ([after a dry run](ORCHESTRATOR.md#after-a-dry-run)). It closes once. The flag outlives the close, and stays Martin's: the store takes its events on the closed improvement ([closing](EVENT-STORE.md#events)), so he may turn it off, which closes nothing more, and straight back on, or narrow it to Share and have it compared again, as for one closed as turned off. The line never moves a flag.

### The probes' checks

Every request the [probes](PROBES-AND-CRAWLER.md#a-flags-check) make carries the mark, which a flag is on for from Checks: against the stable Service they see a flag off only while it is at Off, and on from Checks. So the line has them check each improvement's flag with the flag off first, as a baseline, and then at Checks and at Preview, each run with the journeys, the `/device` check, and pictures of the pages the improvement's latest spec names (`spec.written`'s `pages`, up to six), or of the front page when it names none, each in both colour schemes: once with the browser saying it prefers light and once dark (`prefers-color-scheme`), so a change that answers to either, such as a dark mode, shows. The journeys run once, in the browser's default: the pictures are evidence for Martin, never judged. They show the change rather than prove its criteria, which the pull request's own tests prove: the probes are written blind, and none knows the new feature.

- **What waits on them.** The admin service refuses Checks until the line has a baseline for the improvement with each page it pictured in both colour schemes, so the check there has something to compare with on both sides; a widening past Checks until the check of Martin's move there has passed; and past Preview until the check at Preview has ([the flags' stages](ADMIN-SERVICE.md#the-flags-stages)), so each stage is checked before the flag goes past it.
- **Of the move it judged.** A check at Checks or Preview names the revision Martin's move there wrote (`moveRevision`), beside the revision its run saw (`revision`, newer when another flag has moved since), and a comparison at Share does too. Every write of the flag set has a revision of its own, so a judgement counts, for the line's next pass, the admin service and the console alike, only while the move it names is Martin's latest of the flag: one started for an earlier move and appended after a later one never counts for the later one, which is judged afresh.
- **Asked and polled.** Each pass asks the probes worker (`POST /v1/flag-check` on Verify's port, `PROBES_URL`) for each check due, once: it answers that the check runs, and the next pass's ask joins the run, until it answers. Only then does the line append anything. Without the probes, the checks wait.
- **The stage seen.** Each run reads the revision of the flag set the app holds (`x-flags-revision`, as the admin service reads it) before and after, and the version it runs: a revision other than the one Martin's latest move of any flag wrote (`none` before his first), or a version that moved, says the run may not have seen the stage, and nothing is appended; the next pass asks again. The line drops, too, a check of a stage Martin moved the flag from while it ran.
- **Off, the baseline.** While an open improvement's flag is at Off, never staged on it, once for each version the stable Service runs and each flag set (another flag moved changes what the probes see): the probes say when the version is one the improvement's latest baseline was taken of, with the same flag set, and run nothing. A baseline missing a page in either scheme (as every one taken before Verify pictured dark is: each of its pages reads as light) is taken again, once, on the same version, so Checks can be taken with both schemes to compare with. `flag.checked` with `stage: off`: the version, the revision, how many checks ran and passed, each that did not pass cleanly (failed, or could not tell), and the pictures, each with its scheme.
- **Checks.** Once for each of Martin's moves to Checks, against the latest baseline taken for this improvement (never another's that reused the flag's name), whichever version it was taken of (`against` says which; a release between the two would show in both the journeys and the pictures). The [journeys gate](CI-PIPELINE.md#journeys)'s rule: a check that passed cleanly in the baseline and fails, or cannot finish, twice with the flag on regressed, the `/device` check among them, so anything the flag starts to keep on a visitor's device fails it. Each page with the flag on, in each scheme, compared pixel by pixel with the baseline's picture of it in the same scheme. `flag.checked` with `stage: checks`, `passed` or `failed` with the reason in words, or `unsure` when no baseline was taken before the flag went on, or when the baseline named fewer failing checks than failed (more than an event keeps) and something regressed. Checks is no longer taken before a baseline, so unsure comes now from the cut list alone, or from a flag moved to Checks by hand outside the admin service; either way the line checks a move once, so an unsure at Checks leaves Off, which closes the work item, as the one way on; its pictures off and on are the work item's evidence, which Martin judges when he widens.
- **Preview.** Once for each move to Preview: a probe first asks the app to preview the flag on its front page, as the console's link does, and the rest run with the preview cookie it sets. Judged as Checks, and failed too unless the `/device` check allowed the preview cookie, as kept to [its contract](FEATURE-FLAGS.md#its-contract): so it passes only with the preview cookie allowed and nothing else kept that the baseline did not keep. `flag.checked` with `stage: preview`, and what the device check allowed and found kept.
- **The pictures.** The probes worker keeps them in the artifact store and indexes them in `flag_pictures` (`0034_flag-pictures.sql`, each with its scheme since `0036_flag-picture-schemes.sql`), as it does a release's: the line names only pictures that index vouches for, and one no event came to name is forgotten a day after it was taken, with its images ([forgetting them](PROBES-AND-CRAWLER.md#forgetting-them)).

### Share

A flag Martin set at the share stage is on for a share of the [traffic generator](TRAFFIC-GENERATOR.md#its-ids)'s signed requests, and off for the rest: two sides of one version, at once. Verify compares them (`line/compare.ts`), and the admin service refuses Everyone until the comparison of his move has passed ([the flags' stages](ADMIN-SERVICE.md#the-flags-stages)).

- **The sides.** Each of the generator's 101 ids on the side the app puts it, worked out with flagd's own rule as the app evaluates it ([the share's signed ids](FEATURE-FLAGS.md#which-side-an-id-is-on)).
- **The figures.** The generator's own, by id (`factory_traffic_request_duration_seconds`, job `software-factory/traffic`, and only the series the collector stamped as from its pod in `factory`, so the app, which may send the collector any metric, cannot send these: `provenance.ts`), through Verify's Prometheus (`PROMETHEUS_URL`), summed over each side: requests from the `+Inf` bucket, errors as 5xx answers and no answer at all, and the 99th percentile interpolated over the side's buckets as `histogram_quantile` does. The app never labels them, so the code being judged does not mark its own work, and visitors are never in them.
- **The window.** From a minute after Martin's move, the time the app has to hold it (`FLAGS_HELD.takeSeconds`), to now, less each canary's time in flight from the line's own record of its releases (each `release.started`, a retry's too, to the promotion, rollback, abort or error after it; a dry run's left out, and a version found live, recorded started and promoted at once), padded by how often the line reads releases (30 s), since its two versions would mix with the two sides. One instant query for each piece left: the increase of each id's buckets over it, so a generator restart is counted across, for a series there as it began, and the whole of a series born in it (the generator makes one at its first request of an id and class, and an increase would take its first count, an id's first 5xx, as where it starts): `sum by (share_id, status_class, le) ((increase(B[<piece>s]) and B offset <piece>s) or B)`. The pieces' buckets are summed before the percentile is taken.
- **The judgement.** The canary's thresholds (`policy/release.ts`), flag on as the canary and flag off as its baseline: errors more than a point above, or a 99th percentile more than a quarter and 100 ms above, fails. It is judged once each side has `minRequests` and the window, less what was set aside, is at least `flags.windowMinutes` (30): one cycle of the generator's walk, in which every page meets every id once, so each side has the same mix of pages. Until then it waits, and appends nothing; without Prometheus it waits.
- **Once for each move.** `flag.compared`, by the line, on the work item: passed or failed, both sides' figures, the window, the minutes set aside (`setAsideMinutes`), and on a failure its reason in words. Never judged again until Martin moves the flag; a comparison of a move he has since replaced is dropped, and one that names an earlier move (`moveRevision`) never counts for a later one ([of the move it judged](#the-probes-checks)). A narrower share is a move, and compared afresh; so is a flag on a closed work item, closed as verified at Everyone, or turned off from there and back on, then narrowed to Share.

## Dry run

A merge the dry run made never ships, so with `LINE_MODE=dry-run` the line releases it by the dry run's word, `LINE_DRY_RUN_RELEASE_SECONDS` apart (60). Each event has `dryRun: true` and actor `factory`:

1. `release.started`, recording two steps, each pausing that long;
2. `canary.stepped` at a quarter, and at half;
3. `release.promoted`;
4. `verification.finished`, cleared.

An improvement has nothing to verify by a sense: after its dry run's `release.promoted`, the line hands it over ([verify by variant](#verify-by-variant)).

A line running live closes a dry run's merge with no change as it starts ([after a dry run](ORCHESTRATOR.md#after-a-dry-run)).

A dry run's release never shipped, so it sets off no look again at a held or waiting work item: only a real promotion does, which with `RELEASE_ROLLOUT` the line records in a dry run too. Its closes are then the GitHub worker's records. Without it, held work items are never looked at, and a waiting one goes on to Build as `unsure`.

## With just one work item

With Martin's take of Just one, or `LINE_ONLY` with no take set ([orchestrator](ORCHESTRATOR.md#taking-work)), the watch records only a release that carries that work item or none. One that also carries another is left for the whole line, and that work item stays held at Release. The line says nothing of what the deploy pull request carries, but still records where it stands for that work item. Its spec waits for no other work item, and the stable version a look again reads may lag the app's, since a release that carries others goes unrecorded.
