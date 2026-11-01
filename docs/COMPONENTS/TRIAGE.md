# Triage

An agent: turns signals into tickets. Part of the [factory plane](README.md#agents).

- **Reads:** probe, crawler, telemetry and canary signals; user reports; the planner's findings.
- **Produces:** deduplicated, classified tickets with evidence.
- **v1:** `packages/triage`, run by `factory triage`. It takes signals from [the inbox](ORCHESTRATOR.md#the-inbox).

```mermaid
flowchart TD
  signal[Signal] --> kind{From}
  kind -- a sense --> policy["policy/triage.ts: category and severity"]
  kind -- "a report, or a planner's finding" --> jev["Jev (triage/v2)"]
  policy --> look["Looks at what the sense reads"]
  look --> match{Matches by fingerprint}
  match -- an open ticket --> repeat[A repeat on that ticket]
  match -- "a ticket closed as verified" --> healthy{"What it reads healthy?"}
  match -- none --> healthy
  healthy -- no --> environmentHold["Holds for Martin (environment),<br>with no ticket"]
  healthy -- "yes, a verified ticket" --> reopen[Reopens it]
  healthy -- "yes, none" --> burst{"A burst from its sense?"}
  burst -- no --> open[Opens a ticket]
  burst -- yes --> burstHold["Holds for Martin (burst),<br>with no ticket"]
  jev -- a report --> route["Routing as plain code"]
  jev -- a finding --> held["Holds for Martin (finding),<br>or joins an open ticket's evidence,<br>or a held finding's hold"]
```

## Every signal

- **A sense's signal** takes its category and severity from `policy/triage.ts`, and repeats by fingerprint.
- **Only reports and the planner's findings go to Jev** (`triage/v2`), with routing as plain code.
- It quarantines injection attempts, and parks suggestions for Martin, which close when he [rejects them](#a-suggestion). A quarantine is recorded as typed judgement refusing the report (`action.refused`, mechanism `typed-judgement`, guardrail 8), on the quarantined work item before it closes, appended as triage's role, the only role that may append a refusal by typed judgement (`policy/refusals.ts`). Its output is Jev's typed answers verbatim, with their probabilities, one line an answer; never the report's words, nor the questions, which are the factory's.
- **One fingerprint, one ticket.**
- **More new problems than a handful from one sense at once** wait for Martin as one [burst](#a-burst), before any has a ticket. An open ticket's problem seen again where no release explains it counts as new.
- **A new problem seen while what its sense reads was not healthy** waits for Martin too, its cause [the environment](#what-a-sense-reads).

## Matching an open ticket

A sense's signal on an open ticket adds its evidence (`signal.received`) the first time that sense sees it in each version of the app. So the ticket records every version the problem was seen in, so every version of the app rolled back on it, and the planner is told each. Within a version, the inbox counts it (outcome `counted`) and nothing is appended: the events grow with tickets and releases, not with the minutes a defect stays unfixed.

Nothing reads a counted signal again, so triage deletes each three days after it arrived (`INBOX` in `policy/triage.ts`), when it starts and every hour. It keeps each sense's newest signal, from which a restarted watcher takes up, and the canary's, whose ids the line sends again after a restart. Signals that opened a ticket, are held, or still wait stay: triage's burst and hold reads look at them.

- An open ticket on `*` (a class the crawler found on every page) takes its class's signals on any route.
- But not where the canary is on either side: the canary's `*` means worse on more than one route, or on routes its analysis could not name, so it matches only another canary `*` ([rollback signals](RELEASE-AND-VERIFY.md#rollback-signals)).

## Reopening a verified ticket

A sense's signal that no open ticket has, on the exact fingerprint of a ticket closed as verified, reopens it (`work-item.reopened`, then the signal): the same defect came back, and [the line](ORCHESTRATOR.md#a-ticket-that-reopens) takes the work item back into Plan.

It counts as a repeat on that ticket instead when:

- the sense saw it before that close: it is of the version the fix replaced;
- the ticket's last verification was a dry run's, whose fix never shipped. The line reopens that ticket when it runs live ([after a dry run](ORCHESTRATOR.md#after-a-dry-run)).

A report or a planner's finding never reopens a ticket.

## A burst

A sense that finds many new problems at once may have found as many defects, or one fault in what it reads, such as a gap in the log that looks like a missing record on every page. Each ticket would be a planner's step and more, so triage holds a burst for one look from Martin instead (cause `burst`).

- **What counts.** A sense's signal that would open a ticket, when with it that sense has found more than five new problems within ten minutes of it (`BURST` in `policy/triage.ts`, human-owned). It counts the tickets the sense opened in that time, and the new problems in its signals still waiting in the inbox, so a burst that arrives at once is held from its first signal. One that reopens a verified ticket never counts.
- **An open ticket's problem, seen again.** A signal that would add evidence to an open ticket, the first time its sense sees it in a version, counts as a new problem, and is held as one, unless a release explains it: its version went live at most thirty minutes before it arrived (`BURST.releaseMinutes`). A release puts a version live when its canary starts, when it is promoted, and when a rollback or an abort restores it, as the line records; for a release the line did not watch, when a sense first saw it. Every sense sees each open defect again within a run or two of a release, which is the release's doing; a sense seeing many of them again on a version long live, at once, has had them stop and start again, or has a fault in what it reads. A repeat in a version the ticket has it in never counts.
- **What it holds.** One work item, held at Triage with no ticket, so nothing of it reaches Plan, nor any open ticket. Each new problem the sense finds while it waits joins it as evidence, however long after; one it holds already is counted. Other senses carry on as ever.
- **A fresh app.** The line's first start on a fresh app finds many problems by design, and costs this one answer: a first look at what the senses see is worth it, and approving lets them all through.

### Martin's answer to a burst

And to problems held for the environment.

| Answer | Does |
|---|---|
| Approve | Makes of each problem what it would have made without the burst, in the order the sense sent them: a ticket, as a rule, which the line takes in its turn, or evidence on its open ticket, opened before or since. Closes the burst, naming the tickets |
| Reject | Closes it with no ticket. A problem the sense still sees is found again, and counts toward a burst afresh |
| Answer in words | Leaves it waiting: it is still held, and Needs you lists it, until he approves or rejects it |

Triage does as he answered once an event is appended, as for a finding.

## What a sense reads

Each sense reads something besides the app, and when that fails a sense can see the app as broken. A Loki on a full disk stores no records, and the log watcher would see a missing record on every page. No agent can mend a full disk or a backend that stores nothing, so triage looks before it trusts a sense's signal.

- **What each reads.** `ENVIRONMENT` in `policy/triage.ts` (human-owned): the log watcher reads Prometheus, Loki and Tempo; the metrics and the canary, Prometheus; every sense, the disk under the cluster's volumes, which the app, the senses and the backends share.
- **Healthy.** Prometheus, when the targets whose series the senses read (`ENVIRONMENT.targets`) are there and `up`, and metrics still arrive over OTLP, where the app's own are: Traefik, whose requests the canary's analysis counts, and each node's kubelet, whose volume stats are the disk's measure. Any other target down, such as a platform controller crash-looping, holds nothing; one of these down is named by its namespace and pod, or its node, in the hold's reason. Loki, when it stored a record sent over OTLP in the five minutes before, the pod log collector's aside; Tempo, a trace in the ten minutes before. "Answers" is not enough: a Loki on a full disk answers every query, and returns nothing. The disk, when every volume has a tenth or more free, below which the kubelet starts evicting pods. A backend that cannot be asked, or has no measure, is not seen to be healthy.
- **When.** As of the time the sense saw it, so a signal that waited in the inbox is judged on how things stood then. One look a minute serves every signal seen in it, unless a backend did not answer when asked twice: the next signal asks again.
- **The look is evidence.** Each sense's signal records it (`environment` on `signal.received`): a ticket that opens shows how its sense's dependencies stood when it was seen.
- **What it holds.** A signal that would open or reopen a ticket while anything its sense reads was not healthy is held for Martin as a burst is, with cause `environment`: one work item with no ticket, which every new problem the sense finds while it waits joins. A signal on an open ticket adds its evidence as ever. Martin answers it as [a burst](#martins-answer-to-a-burst).
- **Where it looks.** `factory triage` looks at the backends it has an address for (`PROMETHEUS_URL`, `LOKI_URL`, `TEMPO_URL`; the disk through Prometheus). With none, it looks at nothing and holds nothing for the environment. The cluster's triage has all three.

## A suggestion

A report or a planner's finding that Jev judges a suggestion (a request for something new, not a fault) is parked for Martin (cause `suggestion`), with no ticket: only he asks for improvements.

| Answer | Does |
|---|---|
| Reject | Closes it, with no ticket |
| Answer in words | Leaves it waiting: it is still held, and Needs you lists it, until he rejects it |

A suggestion never starts work, so approving one does nothing, and Needs you does not offer it (spec 5.3: a report only ever leads to a defect fix). Martin, having read one, asks for the improvement himself with the "+" on Plan, in his own words ([admin service](ADMIN-SERVICE.md#an-improvement)): only his roles may open an improvement, and triage never does. Triage acts on his rejection once an event is appended, reading the suggestion holds by an index of their own, and leaves an answer it cannot act on as it leaves [a finding's](#martins-answer-to-a-finding).

## How long a report is kept

A visitor's report is kept for 30 days from when it was received, wherever the factory keeps it: the words they typed, and the page they sent it from as they sent it. Triage forgets each 29 days after it reached the inbox (`REPORT_TEXT` in `policy/triage.ts`), a day short, as it prunes the inbox, when it starts and every hour, so the hour between passes still falls inside the 30 days. A report that waited for the gateway, as one does while a spend cap holds, is forgotten by when it arrived, not when triage got to it, and one that has waited 22 days (`judgeDays`) is never judged at all: it is forgotten unjudged, so Jev's cassette of it, kept seven days, is gone in time too.

- **The events.** The text goes from the report's `signal.received` and from each `judgement.made` Jev made of it, appended with it. The events stay: they are what the console, the audit log and the scoreboard are made from, and the store keeps every event (append-only, but for [this one change](EVENT-STORE.md#the-table)). What is left is valid at its version, as a report read from a public record has no text either, so every view reads it as a report whose words are withheld. The page stays as the event has it, a path with no query and nothing private in it: the factory's own, which the work item's title and the public view give everyone.
- **The inbox.** The report's row goes, triaged or not, with its text and the page as it was sent. The log watcher takes up from the newest report the inbox holds, or from a day back when it holds none, and Loki keeps seven days: nothing could send one that old again.
- **What is not the visitor's stays.** A work item's title, description and story, and a ticket, are the factory's own words, never the visitor's: they quote no report. Jev's answers and the passage of the page it chose are the factory's too. Martin's words on a hold about a report are his own. A planner's finding is the factory's own words, and stays; so do a store's [samples](SAMPLES.md), whose reports are invented.
- **The gateway's cassettes** of Jev's calls hold the report it judged. The gateway deletes each seven days after its last call, whatever else would keep it, and triage asks within 22 days of a report's arrival, so it is gone by the same 29 days ([keeping them](LLM-GATEWAY.md#keeping-them)).

Triage does it through one function the store gives its role (`forget_reports`, `0032_forget-reports.sql`), which runs with the owner's rights and does only that, and never sooner than 29 days, whatever cut triage gives it: the role may change no event, and delete no report from the inbox, itself, so even a compromised triage cannot erase a report, a quarantined one's evidence among them, before its time. A store migrated to it forgets every report already older than that as soon as triage next starts; there is nothing to run by hand.

Elsewhere the text goes sooner, or is the cluster's to keep:

- **Loki** keeps the app's log, the widget's records among them, for seven days, and **Tempo** its traces for three ([telemetry](TELEMETRY.md)).
- **The node's container logs**, the files the app's output is written to before the collector reads them, are rotated by size, not by time, and kubelet has no setting for their age. They go with the pod: every release replaces it, and the shop's weekly dependency and image updates, once Martin merges them, release it well within 30 days. An [alert](ALERTING.md#the-shops-pod) tells Martin when the shop's pod is 25 days old, so that a release replaces it before a report in its logs is 30.
- **Postgres** keeps the old version of a row it changed or deleted until autovacuum reclaims it, which it does on its own.
- **Martin's console** keeps the full events it has read in the tab, and a report forgotten meanwhile is quoted there until the tab loads them again; a session lasts 30 minutes at most.
- **A gateway on the host** in `replay-record`, as `AGENTS.md` runs one against the cluster's store, prunes nothing: its folder is the one a developer gave it, kept out of the repository, and what it recorded of real reports is theirs to delete.

## The planner's findings

A planner's finding is trusted no more than a report, since a visitor can read the app's public code and argue an agent into seeing a bug. It is judged the same way but never opens a ticket (`routeFinding`). Nothing else opens a ticket from a finding. One quarantined is recorded as typed judgement refusing it, as a report is.

- **A defect it noticed** holds for Martin (cause `finding`), with its fingerprint as a report's ticket would have it: the route the planner named and the symptom Jev judged, or, for wrong words, the passage of the page Jev chose.
- **One that repeats an open ticket** joins its evidence, though never the ticket the planner was planning, which it is beyond. One with that ticket's fingerprint is held, saying so, until that ticket closes and a sense's ticket can take it.
- **One a held defect has.** Another finding with the fingerprint of a defect still held joins that hold, its words kept beside the first's, so one defect waits for one answer.
- **A later ticket.** A ticket triage opens later with the same fingerprint, from a sense or a report, closes the held defect into it ("A sense saw it: ticket #N").

### Martin's answer to a finding

| Answer | Does |
|---|---|
| Approve | Opens its ticket on its own work item, with the category and severity `policy/triage.ts` gives its symptom, as a sense's would be, or joins it to an open ticket that has it |
| Reject | Closes it |
| Answer in words | Leaves it waiting: it is still held, and Needs you lists it, until he approves or rejects it |

An answer settles only the findings that reached the hold before it, in the store's order, however it was written. If one joined after it, triage acts on none of them: the hold starts again on the same work item, and waits for an answer that has read them all.

Triage does as he answered once an event is appended, reading only the finding holds (an index of their own), and only answers one of [Martin's roles](EVENT-STORE.md#martins-commands) appended: any other is ignored, and logged. If it cannot act on his answer in as many tries as a signal gets, it leaves the answer: the hold starts again, saying which answer it could not act on, so Needs you asks him again and a restart has nothing answered to try. His next answer is tried afresh.
