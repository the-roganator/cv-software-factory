# 0023: The scan lists a pin that is merely behind, and the factory queues Dependabot's bump of its own workflows in the app

Martin decided both on 24 November 2026.

## Decision

### A pin that is behind is a move

The daily scan (ADR 0013) lists a pin that is merely behind, with no finding a newer release would clear, as a move: a routine update (`apps/factory/src/vulnerabilities/routine.ts`). It clears nothing and has no deadline. Everything after the listing is what a fix has (ADR 0022): the same lanes, the same pull requests, the gate's same rule, the same table of levels.

- **What is behind, by the kind of pin.** An image's pin: the newest tag on its line, or the same tag at the digest the registry serves. A chart: the newest on the pinned major, and the next major only when the pinned one has nothing newer, marked a major. k3s: the newest release on its line. A lockfile's direct dependency: the newest release its manifest's range admits, and one outside the range only when the range admits nothing newer, a major whatever its numbers.
- **What is never listed:** what mise pins, since the toolchain moves when someone upgrades it or for a finding; an image of ours, which the deploy pull requests pin; a line no longer built; and what `ROUTINE.leave` in `policy/vulnerabilities.ts` names, each with its reason: `@types/node` across a major, Playwright's library packages, flagd's image and the Claude Agent SDK.
- **The wait.** A release is listed once it is 3 days old, 7 for a major (`ROUTINE`), on top of the waits a fix has. A tag built again comes due 3 days after the scan first saw the pin behind it. The scan's state keeps each release's first day (ADR 0021).
- **One pin, one move.** A pin a finding's move has gets no routine update that day. The listing runs after the findings are judged and changes none of it: no fix, no deadline, no verdict. A lookup that fails costs that pin's routine update for the day.
- **Who makes it.** In this repository the pin watch, in a pull request apart from the fixes of the same files, so a routine update never holds up a fix; in the app the line, from a signal that says the dependency is outdated, under a `chore(deps)` title, verified when the next scan of the release no longer lists the move. The pin step moves a routine update's package to exactly the release that waited, where a fix's target is a floor.
- **Which merge.** The gate passes a routine update as `move`, or as `major` when it crosses one: it clears nothing, so no Critical releases it. `ENQUEUES` queues a `move` at Guarded and Lights-out and a `major` at Lights-out alone, as for a fix.
- **It raises no alert.** Nothing is due, so Martin's phone hears of no routine update.

### The app's pins of the factory's workflows

A workflow's pin stays Martin's at every level, Lights-out included: in this repository the scan lists one in the `issue` lane, with a finding or none, and in neither repository has the App a `workflows` permission. There is one exception. The app's repository calls the factory's own workflows (its gates, the review gate, the scan) at a commit of the factory's `main`, and those pins move with nobody's hand on them:

- **Dependabot writes the change.** Its pull request in the app moves the commit, and the App writes nothing.
- **The gate judges it** as `exact-pin` (`workflowPin`, `scripts/review-routing.ts`): Dependabot opened it, by id, from a branch of the app's repository into `main`; every changed line is a call of the factory's workflows, each moved from one commit to one commit; the new commit is ahead of the old and on the factory's `main`; and each called workflow declares the same `workflow_call` inputs, secrets and outputs at both commits. A bump that changes what a caller gives is Martin's, who moves the pin and the caller together.
- **The GitHub worker queues it** (`workflowPinQueueWatch`, `github/deploy-queue.ts`), at Guarded and Lights-out with auto-merge on, by `ENQUEUES`, once its required checks are green. The enqueue is the one thing the factory does to a pull request it did not open, and only the worker's own watch may ask for it: the guards refuse the same enqueue to every request over the worker's door.
- **The App has no `workflows` permission, and needs none.** GitHub's queue merges a pull request that changes a workflow when an App without that permission added it.

Guardrail 10 says so, as its one stated exception (`policy/guardrails.ts`, spec section 6). A third-party action's pin, in either repository, still waits for Martin.

## Why

- **For want of an advisory, a pin stayed old.** The scan moved a pin only when a finding had a fix. Everything else waited for Dependabot, which reads no chart and no k3s, and whose pull requests Martin merged by hand, one at a time.
- **One mechanism, already proved.** A routine update is a pin going from one version to another, which is what the gate's `move` rule proves byte for byte and what the pin watch, the pin step and the line already make. A second path for updates would be a second thing to keep right.
- **The wait is Dependabot's cooldown, carried over.** Three days, and seven for a major, are the cooldowns `.github/dependabot.yml` held for the same pins, for the same reasons: most malicious releases are pulled within hours, and the first release of a major is the one most often followed by a fix (postgres.js 4.0.0 lost LISTEN after a failed reconnect, and 4.1.0 fixed it a week later). A fix does not wait so: not patching is the danger there (ADR 0022). The scan holds the wait where Dependabot could not: it reads an image's own creation day, and counts from the day it first saw a release where a registry gives none.
- **Apart from the fixes.** A routine update whose checks fail must not keep a fix from merging, so the two never share a pull request.
- **The factory's workflows are the factory's own code.** A commit on the factory's `main` is one Martin merged, or the factory merged within what he set, and it has passed every gate there. Moving the app's pin to it decides nothing new about that code, as the local deploy pin decides nothing new about an image (ADR 0017); and a gate that reaches the app only when Martin moves a pin by hand is a gate the app runs late.
- **Not `workflows: write` for the App.** The workflows hold the gates and the only secrets in Actions. An App that can write them can rewrite what judges it, and that it cannot is a guardrail with a proof of its own ([the GitHub worker](../../COMPONENTS/GITHUB-WORKER.md#proving-the-app-cannot-touch-workflows)). Dependabot already writes this change, and the gate can prove it is this change and nothing else.
- **Not a workflow that merges.** No workflow opens, approves or queues a pull request here: a workflow that did would hold a credential that merges in the place a pull request can change, and would decide by a rule outside the gate's. The worker already holds the one key that enqueues, reads the level, and adds only what the gate passed at that head.
- **The declaration check, because a bump moves the commit alone.** A workflow that asks its caller for a new input or secret breaks the app only once the bump merges, and what breaks may be the gate that would judge its repair.

## Consequences

- Dependabot's pull request for a pin the scan lists closes itself once `main` has moved. `.github/dependabot.yml` keeps its settings: it alone proposes what the scan does not list, the actions the workflows use among them, and those wait for Martin.
- A routine update can bring in a release that is itself bad, as a fix can (ADR 0022). What stands against it is the wait, pnpm's guards and mise's release age, the required checks on the head and in the queue, admission (ADR 0010), and in the app the canary's analysis and rollback.
- A routine update across a major waits for Martin at Guarded, with nothing in Needs you and no alert: its pull request's description says so.
- A release its registry does not date (a tag built again, an image that says 1970) waits from the day the state first saw it, so losing the state starts that wait again.
- **The gate that judges a bump is the gate at the old pin.** `review.yml` runs as the app's `main` calls it, so the bump that brings a change to the gate is judged by the gate before that change.
- **The declaration check reads what a workflow declares, not what it needs.** A workflow that comes to need something it does not declare is passed: a trigger the caller must list, a permission the caller's job must grant, a variable or an environment of the caller's repository, a required check's name its ruleset must hold.
- The worker writes nothing to Dependabot's branch and says nothing on its pull request. A required check that failed on the head, and a head the queue took out three times, wait for Martin or for Dependabot's next rebase, and only the worker's log says so.
- The app's `.github/dependabot.yml` keeps the factory's workflows in a group of their own, with no cooldown: a commit of the factory's `main` has waited where it was made, and a pull request that also moves a third-party action is no exact pin.
- This decision amends ADR 0014, whose `exact-pin` has a second check; ADR 0017, whose worker queues one pull request that is not the App's; ADR 0021, whose state keeps the routine updates' days and what carries an image's findings; and ADR 0022, whose lanes give the Makefile's pin of Argo CD's chart to the worker.
- `AGENTS.md`'s rule on who merges names Dependabot's workflow pins in the app beside the worker's other two.
