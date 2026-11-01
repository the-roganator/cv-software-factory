# Orchestrator

Work queue, state, retries, concurrency and stopping the line. Part of the [factory plane](README.md#factory-plane).

- **v1:** Postgres-backed queues and TypeScript workers: the inbox, and the line.
- **Later:** Temporal, AWS Step Functions.

After the merge, the line carries a work item through [Release and Verify](RELEASE-AND-VERIFY.md), which has a page of its own. The agents it runs are [the planner](PLANNER.md), [the coder](CODER.md), [the reviewer](REVIEWER.md) and [the describer](DESCRIBER.md).

## The inbox

Senses insert signals, and the line inserts the planner's findings. Each finding carries an id from its work item and what it says, so neither a step tried again nor a later plan leaves one twice.

[Triage](TRIAGE.md) takes each signal once, with `for update skip locked` under a lease, woken by `NOTIFY`, with a limit on attempts.

## The line

`apps/factory/src/line`, run by `factory line serve`. `LINE_MODE` sets what it does:

| `LINE_MODE` | The line |
|---|---|
| `off` (the default) | Takes no work |
| `live` | Acts in GitHub through the [GitHub worker](GITHUB-WORKER.md) |
| `dry-run` | Has the GitHub worker record what it would do ([dry run](GITHUB-WORKER.md#dry-run)) |

The `line` table holds the work items on the line, by stage and under a lease.

```mermaid
flowchart LR
  ticket([Open ticket]) --> plan[Plan]
  plan -- spec --> build[Build]
  plan -- spec overlaps work in flight --> waits[Waits]
  waits -- its signal still there --> build
  waits -- its signal gone --> closed
  build -- push --> gates[Gates]
  gates -- fail --> build
  gates -- pass --> review[Review]
  review -- blocking findings --> build
  review -- approved with suggestions, once --> build
  review -- approved, described --> merge{{Merge}}
  merge --> release[Release]
  release -- promoted --> verify[Verify]
  verify -- cleared --> closed([Closed as verified])
  verify -- persists, once --> plan
```

Each stage can also hold for Martin (see [Holds](#holds-and-martins-answers)).

### Taking work

- It takes the oldest open ticket of the highest severity into Plan when nothing is in Plan or waiting for Build. A work item that waits for overlapping work (below) is at a stage of its own, `waiting`, so the line still takes the next ticket.
- An [improvement Martin asked for](#an-improvement) waits behind every open ticket not yet taken, and the oldest goes first.
- It runs one step at a time in each of Plan, Build and Review.
- It runs one step at a time on the local model, whatever its stage, since LM Studio answers one prediction at a time. A step whose agent the settings in force send there ([below](#settings); every agent, under `ALL_LOCAL`) waits while another such step runs, and the line tries again on its next pass. A step on Claude never waits for one on the local model, so a mixed profile keeps its pace.
- As a ticket enters Plan, before anything else, the sense that saw it looks again if its signal was last seen on a version before the one the stable Service runs, since a release since may have fixed it ([Verify](RELEASE-AND-VERIFY.md#open-tickets-a-release-may-have-fixed)): cleared, it closes as verified, with no issue opened and no planner, and the line takes the next ticket at once.
- As a ticket enters Plan, it opens the ticket's issue through the App, from the ticket's public view. The fix's pull request refers to that issue. An improvement's issue has its title and Martin's words, from their public views.
- After Martin's merge, it carries the work item through Release and Verify until it closes.

What it takes is Martin's to set in the console's Controls ([admin service](ADMIN-SERVICE.md#the-lines-controls)), read at each pass as `controls.changed`'s latest from his roles, held to policy by `policy/line.ts` as it is read: Every ticket, The next few (counted from when he last chose a number, at most 20), or Just one. The next few count improvements as they count tickets, and Just one takes an improvement at once, as it takes a ticket. With none in force, before he sets one or when the latest is outside policy, two settings are the line's own default:

- **`LINE_ONLY`**, set to a work item, makes the line act on that one alone, as Just one does.
  - It takes that ticket or improvement onto the line whatever else is in Plan or Build.
  - It starts no step for any other work item, reads nothing for it and appends nothing.
  - It says nothing of what the deploy pull request carries, but still records where that pull request stands for this work item ([its state](RELEASE-AND-VERIFY.md#the-deploy-pull-requests-state)).
  - It still watches the app's releases, and records one that carries that work item or none (those go on the line). A release that also carries another work item is left for the whole line. The work item stays held at Release (cause `deploy`, so Needs you lists it) until the line records that release, or finds it live.
- **`LINE_TAKE`**, set to a number, has the line take work by its own rule until it has taken that many work items in all, as The next few do from when Martin chose them. The count comes from the `line` table, by when each work item came onto it, so a restart takes none more. It then takes no more, and carries those it has to their end.

A take Martin sets applies from the line's next pass, which his change wakes.

### Agents take new work

Martin's switch in Controls (`newWork`, on by default). Off, the line takes no new ticket and starts no agent's step; a step in hand finishes, and the rest goes on: triage, the senses, Release and Verify, the looks again, and a kept handback's effects, of a step already run. Unlike stopping the line, it aborts no canary, and turning it on again needs no passkey.

### Autonomy and auto-merge

Martin's autonomy level (Supervised, Guarded, Lights-out) and auto-merge of low-risk changes are recorded with his controls, and shown, and nothing routes by them yet: every merge waits for him on GitHub until approval routing comes (Part C, [approval routing](APPROVAL-ROUTING.md)). Auto-rollback, on by default, reaches the canary's analysis as two series, the admin service's read of it and the line's own (`line/auto-rollback.ts`): with both off, a canary whose errors or latency the analysis judges bad pauses for Martin rather than rolling back ([progressive delivery](PROGRESSIVE-DELIVERY.md#auto-rollback)).

### A spec that overlaps

Two tickets can be one defect, seen by two checks on two pages, and that shows only once the planner names the files. So after Plan, before the coder starts and before a spec that always needs Martin is held for him, the line compares the spec's scope with the latest spec of each other work item in flight: on the line, not ended or closed, in any pass, held or merged too. Every shared file counts, tests included: two entries share one when any path is in both, as the scope fence matches them, so `**/test.ts` and `src/**` share `src/test.ts` (`scopesOverlap` in the events package, which errs towards sharing).

- **A spec that shares a file waits** (`wait.started`, naming the work items and the files), at stage `waiting`. A wait is not a hold: it needs nobody, and Needs you does not list it.
- **When each work item it waits on is verified or closed**, the sense that saw its defect looks again ([Verify](RELEASE-AND-VERIFY.md#held-and-waiting-work-items)). Cleared, it closes as verified. Still there, or the sense cannot tell, it goes on to Build with its spec as written: the coder starts from the current `main`, and the gates and review judge the result.
- **While it waits**, each release is looked at as for a hold, and one that clears its signal closes it.
- **No cycles.** A work item never waits on one that waits on it, directly or through others.
- A spec written again before any push is checked again; one written once there is a pull request is not.
- **With just one work item** (Martin's take, or `LINE_ONLY`) there is no wait: a line of one work item sees nothing else.

### An improvement

Martin asks for an improvement with the console's "+" ([admin service](ADMIN-SERVICE.md)), which opens a work item of kind `improvement` with his words (`improvement.requested`). The line carries it as it carries a ticket, with these differences:

- **Only one he asked for.** The line takes an improvement only when its opening and his request were both appended by one of his roles. Row security lets no other role append either. A work item's kind comes from that opening, so a ticket appended to his improvement does not make it a ticket. An improvement a worker opened, or one with no request, never comes onto the line.
- **Its order.** It waits behind every open ticket not yet taken, whatever their ages: a defect in the app goes before something new. Improvements go oldest first.
- **Its spec names its flag and its pages.** The planner's schema refuses an improvement's spec without its title, a flag of its own, its pages, and criteria on each side of the flag ([planner](PLANNER.md#an-improvements-spec)).
- **Its spec waits for Martin.** Every spec of an improvement is held for his approval before any code (cause `spec`, kind `approval`), whatever its risks and in every autonomy mode. A spec written again is held again, even one written while the last was held: his answer to the old card approves nothing. The line reads a spec only as its own role recorded it. Approving it takes the passkey again ([admin service](ADMIN-SERVICE.md)). Rejecting closes the work item, and answering sends his words to the planner.
- **No sense looks at it.** It has no signal, so a hold never looks again, and a wait on overlapping work ends when that work closes.
- **Its merge waits for Martin** in every mode, and its hold says so.
- **It is handed over after its release.** Once a release that carries it is promoted, the line hands it over to the [flag pass](RELEASE-AND-VERIFY.md#verify-by-variant). It leaves one comment on its issue, saying the change is in the app behind its flag, off, and that Martin widens the flag a stage at a time from the console; the GitHub worker says nothing an issue says already, so a hand-over tried again after a crash says it once. Its row on the line ends, but the work item stays open, until the flag pass closes it: as verified once its flag is on for everyone, or as turned off ([Verify by variant](RELEASE-AND-VERIFY.md#verify-by-variant)). A spec waiting on it, for files they share, waits no more. The hand-over stands: the release watch records nothing more of a promoted release, so it never rolls back after it, and taking the change back out is a later release or Martin's turning the flag off. A rollback, or a release that erred or was aborted, holds it for the next deploy, as for a fix. A dry run's improvement waits for the dry run's release, then is handed over.

### A ticket that reopens

When a verified ticket reopens ([triage](TRIAGE.md) reopens it), its work item comes back into Plan for a fresh pass, whatever else is on the line and however many it may take, since the line took it already. Each pass of the line, before it takes a ticket:

1. It waits until the runners' old volume is gone.
2. It reopens the ticket's issue through the App, saying what came back. If the App can no longer open that issue, the work item comes back without it and the line opens a new one.
3. It moves the work item to Plan, forgetting its last pass's failures, pending effects and coder's session.

### After a dry run

A dry run works on real tickets, so a line that starts `live` on the same store finds what the dry run left. It could not carry on from it: GitHub never had the dry run's pull requests, merges or issues, and a dry run's fix never shipped. As it starts, before anything else, it ends each (`dryRunLeft` in `line/machine.ts`):

- **A work item whose pull request or issue was the dry run's**, the pull request merged or not, closes with no change, saying so. Its issue closes too, as not planned, when GitHub has it. The next signal of its defect opens a fresh ticket. An improvement the dry run handed over closes the same way, and Martin asks for it again if he still wants it.
- **A ticket the dry run verified** still has its defect, and reopens (`work-item.reopened`, with `dryRun: true` and the line as its actor). It comes back into Plan as any reopened ticket does, with a new issue, since its own was the dry run's. The planner is told of no fix that came back: none shipped.

What it cannot end on one pass, because GitHub or the store failed, it tries again on the next, and until then it reads no gates and starts nothing for that work item. A reopened work item waiting to come back into Plan is left to that, which forgets a dry run's issue. With `LINE_ONLY`, it ends only that work item's.

### Its metrics

The line reports the work items at each stage and how long the oldest has been there, read from the `line` table, how long each stayed at a stage, each step by agent and how it ended, each hold by cause, each release's end and each verification by sense and outcome ([the line's metrics](TELEMETRY.md#the-lines-metrics)).

## Steps

- **State is derived.** What a work item does next is a pure function of its events (`line/machine.ts`), so after a stop or a crash the line carries on from the last event.
- **One module per agent.** Each agent's module (`line/agents/`) says what its step is given, its prompt and schema, and what its result does in GitHub and as events. The worker runs them all one way.
- **Runners.** Each step runs in an [agent runner](AGENT-RUNNERS.md).
- **Turns and deadlines** are set for Claude. When the settings in force send an agent's calls to the local model (or every agent's, under `ALL_LOCAL`, which the line reads as the [gateway](LLM-GATEWAY.md) does), its step has twice the turns and four times as long.
- **Model calls.** Each step's calls become one `model.called`, summed from `model_calls` by the step's job, with the turns it was given. It counts only the calls a model answered, a cassette replayed, or that failed part way with tokens to show for it; none the gateway or the provider refused.

### When a step fails

```mermaid
flowchart TD
  step[Step runs in a runner] --> handback{Handback}
  handback -- "nothing, out of turns, failing,<br>or refused by the agent's schema" --> second{Second failure?}
  second -- no --> step
  second -- yes --> held[Holds for Martin: failures]
  handback -- result --> effects[Effects in GitHub and the store]
  effects -- GitHub or the store fails --> sixth{Sixth try?}
  sixth -- "no: later, without the agent" --> effects
  sixth -- yes --> held
  effects -- done --> next[Next step]
```

- **A failed step** (one that hands back nothing, ends out of turns or failing, or hands back a result its agent's schema refuses) runs again as a new job. After two failures the work item holds.
- **A failed effect is not the step's failure.** When GitHub or the store fails while a result is acted on, the handback is kept in the `line` table and its effects are tried again later without the agent. Each write in GitHub is recorded as it is begun and done, so none is done twice. After six tries the work item holds.
- **A coder that changes nothing and says why** has not failed:
  - after the gates or a review sent the work back, the work item holds where it came from, under that cause (`gates` or `review`), with the coder's reason;
  - a first round that finds nothing to fix holds as `nothing-to-fix`.
- **A patch the scope fence refuses** is recorded as `action.refused` (`scope-fence`, guardrail 11, with the fence's output and its verdict on each file). It goes back to the coder once, which resumes its session from a fresh checkout. The second refusal holds the work item.
- **A coder that needs a file outside the scope** (an existing test its change rightly makes wrong) changes nothing there, and names each such file and why. The work item holds as `scope` at once, whatever else the round did, with the files and reasons on the hold (`needs`), and nothing of the round is pushed: the planner's next spec starts the coder again from the pull request's head, or from a fresh checkout before there is one. The reason says which of them no scope may name; approving or answering in words then tells the planner to take in only the others and to reject the ticket if the fix needs one of those, and it never widens a scope to them. The fence's refusals count as before.

## Build, gates and review

- **The pull request.** The coder's first push opens the fix's pull request as a draft, with the ticket's issue and the spec. It is readied only once the [describer](DESCRIBER.md) has written its description. Work sent back to Build after that (a gate that fails on a newer commit, or Martin's words on the hold for his merge) puts it back to draft first, so GitHub will not merge a round nobody has reviewed, and the describer writes up the next round again before Martin is asked.
- **Each push** records its own files and the pull request's whole change, as GitHub compares its head with main. A path in the whole change longer than an event records (200 characters), which only a push other than the coder's can put there, is cut to fit and marked, so the console still counts its lines and shows it outside the scope rather than reading it as in it.
- **Reading GitHub.** Once a minute the line reads its pull requests' check runs and merges through the GitHub worker, and appends `gates.started`, `gate.finished`, `gates.finished` and `pull-request.merged`. It leaves out the factory's own check runs. A merge comes after what the gates on the pull request's head did since the last read, so a merge soon after they pass still finishes their round; at a merge, the round ends with it, judged on the checks that have finished. Once gates have passed on a push, a run on a newer commit of it (main merged into the branch, as to resolve a conflict) leaves the work item where it waits while it runs, and replaces them when it ends: if it passes, nothing moves; if it fails, the work goes back to the coder as a failure on the push's first run would, and a wait for Martin's merge, which GitHub would refuse, ends.
- **Failing gates** send the work back to the coder twice.
- **A review's blocking findings** go back to the coder's session, with its suggestions, and a fresh reviewer is told them in the next round. What still blocks after two reviews holds, as does a review the reviewer escalates.
- **Martin's approval of a held review** (`review` or `beyond-ticket`) stands in for the reviewer's, so that he resolves nothing by hand before his merge. Before the describer writes the change up, the line answers every thread of the review still open, and of each earlier finding one holds again, and resolves it, through the GitHub worker, which replies once and passes over a thread already resolved. On a finding the review blocked on it says he accepted it in the console; on a suggestion, which his approval sends on with no round of its own, that he approved the change without one, so it is not taken; a suggestion the coder already declined keeps its own answer. Each reply says when he gave that answer, with his words if he gave any (on a work item a visitor's report opened, only that he accepted it). It records `review.accepted`, with the review and how many of its blocking findings and suggestions it answered. GitHub refusing holds nothing up: the event says so (`refused`), and what is left is his to resolve by hand.
- **An approval's suggestions** go back to the coder once in a pass, before the describer writes the change up, so that every review thread is answered before Martin's merge. The coder takes each or declines it with a reason (`suggestions.answered`). If it takes any, the gates and a fresh reviewer run again, and that review goes on whatever it suggests: suggestions alone never send the work round twice. It counts toward the two reviews like any other, and is at least the second, so if it blocks it holds for Martin. If it declines them all, it changes nothing and the approval stands. Martin's approval of a held review sends the change on with no such round.
- **An out-of-scope spec.** Every spec tagged `out-of-scope` that the planner wrote under the rule (its criteria name where each comes from), a rewritten one too, holds at Plan for Martin's approval before the coder starts, in every autonomy mode ([approval routing](APPROVAL-ROUTING.md)).
- **A spec written again** once there is a pull request sends the work back to the coder, held to the new spec, and sets aside the review of the old one, so the change is reviewed again.
- **The end of a pull request.**
  - A pull request closed unmerged closes its work item: as verified while a look again that cleared stands on its hold (below), and with no change otherwise.
  - A work item whose pull request merges, or that closes, has its runners' volume deleted, since a later pass starts afresh from main.

## Refusals it records for others

Two mechanisms that refuse have no role in the event store, so the line records what they refuse, as `action.refused`, by its own role (`line/refusals.ts`). Repeats of one refusal within a minute fold into one event with how many, as the gateway's do; a fold of the GitHub worker's carries its last refusal's record and signature. Recording one changes nothing the line does: an action refused fails as it would have.

- **The GitHub worker's.** Each refusal it answers one of the line's requests with comes signed ([its refusals](GITHUB-WORKER.md#its-refusals-signed)). The line verifies it with the worker's public key (`REFUSAL_PUBLIC_KEY`, from the ConfigMap `refusal-key`) and appends it with its record and signature, as `github-guard` or `token-permission`, on the work item the request was for, or naming the repository, issue or pull request when the request was for none. One that does not verify, or any with no key, is logged and not appended.
- **Admission control's** (`admission-control`: guardrail 3 for an image, 4 for the rest). The line lists the cluster's Events every 15 seconds with a Role of its own (`deploy/base/line-reads-admission`): list Events, in each guarded namespace and in `default`, and nothing else. Kyverno 1.19 records a request it blocked on the policy that blocked it, which is cluster-wide, so in `default`, with the refused object related; it records none for a pod a controller makes, which has no name yet, so that pod is recorded by the controller's `FailedCreate`, in its namespace, with the webhook's answer, its count growing with each try. The output is the Event's words, the policy's message in them, verbatim. A refusal names the object refused, and goes on the work item when that object is one of its runner's Jobs. The line remembers each Event's count, so each try is recorded once, at most 100 of one Event's at a look and the rest at the looks after; starting again, it takes only what came after the last admission refusal it recorded, and what came in that second for an object and policy it had not recorded then, as an Event's time is to the second. The cluster's own ValidatingAdmissionPolicies (the Rollout's controls, the flags and their stages, the share key and the refusal key) leave no Event, and are not recorded.

## Holds and Martin's answers

Each hold names its cause, and Martin's answer does what `ANSWERS` says for that cause. It is in the events package (`line.ts`), so the console's Needs you says beside each answer what the line will do, from the same table, and offers only the answers that do something (`answersTo`): approving a `merge` or a `deploy`, which the line would only wait after, is not one, and a `canary` hold takes none. He answers from Needs you, through the [admin service](ADMIN-SERVICE.md#needs-you). Rejecting always closes the work item and its issue, where it is offered. The line reads an answer only from one of [Martin's roles](EVENT-STORE.md#martins-commands), and ignores, and logs, any other. On a work item a visitor's report opened, his words stay his (the answer is marked `report`): no agent reads them, as none reads a report, since what an agent writes is public; his answer still does what it does, and the reasons and comments the line writes from it say only that he sent it back, rejected it or judged it cleared.

| Cause | Held when | Approving | Answering |
|---|---|---|---|
| `question` | The planner asks what only Martin can say | Carries on | Carries on; his answer reaches every later plan |
| `ticket-rejected` | The planner rejects the ticket | Agrees, and closes the work item | Carries on; his answer reaches every later plan |
| `spec` | A spec is tagged `out-of-scope` | Carries on to Build | Sends it back to the planner |
| `scope` | The scope fence refused the coder's patch twice, or the coder named files outside the scope it needs | Sends it back to the planner, told, as the line's reading of his approval, that the coder needed those files | Sends it back to the planner with what the fence printed, or the files the coder named |
| `nothing-to-fix` | The coder's first round finds nothing to fix | Agrees, and closes the work item | Sends it back to the planner with the coder's reason |
| `failures` | A step failed twice, or its effects failed six times | Runs the step again | Runs the step again, with his words |
| `gates` | Gates failed after two returns, or the coder changed nothing after gates | Sends the work back to the coder | Sends the work back to the coder, with his words |
| `review` | Still blocking after two reviews, or after the round for an approval's suggestions, an escalation whose findings do not cite the ticket, or the coder changed nothing after a review | Stands in for the reviewer's approval: the review's open threads are answered and resolved as his acceptance | Sends the work back to the coder, with his words; the threads stay open for it |
| `beyond-ticket` | The reviewer escalates a spec that goes beyond its ticket | Stands in for the reviewer's approval: the review's open threads are answered and resolved as his acceptance | Sends the spec back to the planner |
| `merge` | The fix has passed its gates and review | Waits for his merge | Sends the work back to the coder |
| `deploy` | The merged fix waits for a release ([Release](RELEASE-AND-VERIFY.md#release)) | Waits: he settles it by merging the deploy pull request, his once its checks have passed | Waits |
| `canary` | With auto-rollback off, the analysis judged the canary's errors or latency bad and Argo Rollouts paused it ([progressive delivery](PROGRESSIVE-DELIVERY.md#auto-rollback)) | Takes no answer here: he promotes it fully or aborts it from the Canary panel, and the release's end ends the hold | Takes no answer here |
| `verify` | The signal persisted a second time, Verify could not tell for 24 hours, or nothing can judge the fix ([Verify](RELEASE-AND-VERIFY.md#verify)) | Closes the work item as verified, with his words | Sends it back to Plan |
| `spend` | The work item has spent its cap on models | Carries on, and holds again until the cap is raised; raising it answers the hold | Carries on |

Work sent back to the planner is planned again, not from nothing ([planned again](PLANNER.md#planned-again)). The work item keeps its last spec, in any pass, and why it came back (`replan` in the machine's state: the hold he answered, with the files the coder named, what the fence printed or the reviewer's findings beyond the ticket; the return from Verify; or the reopening) until the planner writes another. The planner is told both, and to keep what still holds. Once the work item has a pull request, the planner's step starts where that pull request's branch left main, as GitHub's comparison names it, and is told the pull request and the files it changes; every other step after a pull request starts from its head. An answer's words are his alone: what the line reads into an approval, such as that the coder needed those files, is told beside them as the line's, and no criterion may quote it.

### A held work item whose defect went another way

A held work item's defect can go with another change: a duplicate's fix, Martin's own commit, a dependency update. After each real release is promoted, and once as a hold starts, the sense that saw it looks again at the version the stable Service runs ([Verify](RELEASE-AND-VERIFY.md#held-and-waiting-work-items)). What a look that cleared does depends on the cause (`closesWhenCleared` in `line/machine.ts`):

- **The line's own holds close as verified**: `scope`, `gates`, `failures`, `spend`, and `review` when the reviewer asked for changes once too often. The line closes the issue as completed and the pull request unmerged, each saying which release cleared it.
- **Holds that wait on Martin's judgement stay**: `spec`, `question`, `ticket-rejected`, `beyond-ticket`, `nothing-to-fix`, `merge`, `deploy`, `verify`, `tests-first`, `unknown`, and `review` when the reviewer escalated. The look is recorded, and the hold says the signal cleared on that version. While it stands, his closing the work item's pull request in GitHub closes it as verified.

A signal seen since on that version or a later one, or a later look that finds it, ends the clearance. Triage's holds are never looked at: they come before a ticket reaches the line.

Triage's own holds, `finding`, `suggestion`, `burst` and `environment`, are on [its page](TRIAGE.md). An answer in words to one of them settles nothing, so the hold stands and Needs you still lists it (`WORDS_LEAVE_HELD` in the events package, which the line and the console both read).

## Settings

The line reads Martin's settings as the [gateway](LLM-GATEWAY.md#settings) does, from the same store and with the same check against `FACTORY_PROFILE`'s policy (`line/settings.ts`), afresh at every pass; his saving them wakes it, as any append does, so the pass it wakes sees them. Each step starts under the settings in force as it starts, and keeps them:

- where its agent's calls go, so a step on the local model has its longer bounds and waits its turn there;
- a work item's cap, which the line holds at. It appends a spend hold under the lock every append takes, reading the cap in force again as it does, so a raise Martin saves meanwhile either answers the hold or keeps it from being made.

A step's `model.called` records the settings it ran under: its turns, and the effort the gateway sent its calls at, read for its job as the gateway read them (none for a local model).

## Spend

- **A work item's cap.** Each work item has a cap on models: the gateway's, [in force](#settings) from Martin's settings within the profile's policy. A work item that has spent it holds before its next step, with the cap and its spend on the hold. Martin raising the cap past that spend answers the hold ([admin service](ADMIN-SERVICE.md#the-settings)), and the work item carries on.
- **The gateway's caps.** A cap the gateway has set and not cleared (`spend.capped`: the factory's own day or month cap, or the provider an agent's calls go to refusing) starts no step for that agent, since every call would be refused.
  - A step that hands back an error while such a cap is set, or after one was set while it ran, counts for nothing and runs again once the cap clears.
  - The `spend.cleared` that clears it wakes the line (`line/caps.ts`).

## Stopping the line

Every worker checks for `line.stopped` before it takes work, and heeds a stop or a start only from one of [Martin's roles](EVENT-STORE.md#martins-commands). Martin stops the line from the console's header, through the [admin service](ADMIN-SERVICE.md#stopping-and-starting-the-line), or with `make stop-the-line`, as his command line's role, which works when the console and the admin service do not; each records his reason. Then:

- the line deletes the Jobs of every step in hand at once, starts none still preparing, and records nothing of them;
- it runs them afresh when the line starts, which from the console needs his passkey again;
- Martin is told of the stop, however it was made, at Inform ([alerting](ALERTING.md#security-events));
- a release of the app in flight is aborted ([progressive delivery](PROGRESSIVE-DELIVERY.md)), which the release watch records as `release.aborted` by `stop` ([release and verify](RELEASE-AND-VERIFY.md#its-events)): from the console, by the admin service, after the stop is recorded, with a control that says it came with the stop; from the command line, by `scripts/abort-canaries.sh`, which records nothing, so the line tells its abort by time.

A stopped line still watches the app's releases: it records whatever they do (a start, a step, a promotion, a rollback, an analysis error, an abort) and sends a rollback's signals to the inbox, where they wait. It moves no work item, and a dry run's releases wait for it to start.

## The soak check

`factory line soak-check` reads the store and the cluster the morning after a soak (`line/soak.ts`), and reports:

- leases held past their expiry;
- runners' Jobs and volumes left for ended work items, and volumes left for merged ones;
- events that are not valid once upcast;
- the spend: each work item's within the highest cap on one in force since the soak began, or nothing at all with `--no-spend`, for a night on the local model;
- the work items taken, by how each ended, with their minutes in each stage.
