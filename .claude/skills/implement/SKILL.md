---
name: implement
description: Take issues, or a part of this conversation, to pull requests ready for Martin to merge, through sub-agents, each report checked before it is believed.
argument-hint: "#123 [#456 …] | <what from this conversation>"
---

# Implement work items to pull requests

The work: `$ARGUMENTS`: one or more issues (`#123, #456`), something from this conversation (`the station order part`), or a mix. Take each to open pull requests ready for Martin to merge, or skip it with a reason.

You are the orchestrator. Keep your context lean: sub-agents do the work, each following [`worker.md`](worker.md). Make the calls you would otherwise ask Martin for, and write each one down. The scripts are in `${CLAUDE_SKILL_DIR}/bin/`; give sub-agents that absolute path, since their worktrees may not have this skill.

## Before starting

1. **Key each work item.** An issue's key is its number, and its second pull request `<n>-2`; a brief's is a short slug (`station-order`). A work item whose pull request is in the app's repository (`the-roganator/cv-worlds-worst-website`, checked out beside this one) has a key beginning `app-` (`app-flag-context`, or `app-<n>` for this repository's issue `<n>`): the scripts read the repository from the key.
2. **Make the run directory**: `run.sh <key>...` makes `scratch/implement/<date>-<keys>/` and prints its path. Briefs, notes, PR notes and the summary go there; a later session on the same work takes it up. What waits on Martin (the pull requests to merge, in order, and what to try once deployed) the session tells him in its reply.
3. **Write each brief from the conversation** to `<run dir>/brief-<slug>.md`. The sub-agent sees nothing of this conversation, so the brief stands alone: **Goal** (the change and why, in a paragraph), **Agreed** (every decision Martin made or accepted, in his terms, and every option turned down), **Scope** (the files, components and docs named, and what is out), **Open** (what the sub-agent settles and reports), **Related** (issues, pull requests, commits). Write down what was said, not what you would add. If the conversation left open a decision that changes what gets built, ask Martin now, in one question; if it is a choice between designs, the brief asks for the measurement first, and he chooses after.

   Every brief names its **Proof**, where the code will run: the bench on Claude for a prompt or schema; a run of the workflow on the branch, on the event it changes, for a gate, workflow or scanner; the live try for the line, a worker or a console action; the pull request alone for docs, a test or a skill. It has a line beginning "The minute this merges": what starts, stops, opens or runs again when it lands, and how many times. Before launch a second session or a fresh sub-agent reads each brief against the plan, and you fix what it finds.

   A brief for the app's repository carries this rule, in these words: nothing written in the app's repository, in code, commits, branch names, pull requests or replies, mentions or hints at seeded defects or faults. A brief says when the plan asks for `/security-review`.

   For work that changes what runs on the cluster, trace the whole path it opens against the plan's own words: what runs after it, with what input, and whether that has ever run. A part that has never run is named in the brief and its proof, and so is each part a dry run cannot show ([`try-the-line`](../try-the-line/SKILL.md#what-a-dry-run-cannot-show)), with the live proof that will show it.
4. **Plan by what Martin can merge.** Each pull request costs him a read, a queue entry and often a deploy pin, so name every one the work will open, in merge order, before any starts: about six at most, or split the work. Independent items branch from `origin/main` and merge in any order. A [stack](#stacks) is for work that cannot be built otherwise: three deep at most, never on a draft or a pull request held for a decision, tried once from its top; tell the worker the branch to build on. A shared contract (an event, a vocabulary entry, a schema, a file's format) lands first, alone if it can; only the first pull request that uses it stacks on it, and the others branch from `main` once it merges. One worker owns each file several would touch (`AGENTS.md`, `scripts/workflows.test.ts`, a workflow), named in every brief; the others send it their line. A pull request that needs one in the other repository merged first cannot stack on it: its description says so, and the summary gives the merge order and any `deploy/` pin between.

   The first pull request carries the map in a section of its own, "The run": a line for each pull request in merge order, written as its bare number (`#1066`), which GitHub shows with its title and state, what it adds and what needs Martin. Every other description opens with which of how many it is, and the first one's number.

## Try before review

Reviews pass faults that only running the work shows. So work that changes what runs on the cluster (the line, its agents, the workers, the console's actions) is tried on the local cluster first, and reviewed once, after:

1. **Build.** Brief each worker build-only ([`worker.md`](worker.md#build-only)): it builds its branch, stacked on the one below, with tests and `make check` green, and reports `built` with its head. Check `git ls-remote origin <branch>` shows it.
2. **Try.** Once every part is built, merge `origin/main` into the bottom and each branch into the one above, each by its own worker, so the images tried are what will merge. Build the images from the top branch and run the plan's or the brief's proof with the `try-the-line` skill, time-boxed. Send each fault back to its branch, to a worker briefed build-only with what the try showed, merge it upwards, and try again until the proof passes. Log each try, what it showed, and where each fault went.
3. **Batch Martin's part.** What needs a passkey goes into one short sitting, with what to do and what to look for. An agent's step is tried on the bench first, which needs none.
4. **Finish.** Send each worker, bottom first, to finish its pull request from the built branch: its reviews, `/visual-pr`, the pull request, then Copilot, once each, answered across the stack in one pass ([Stacks](#stacks)). Its description says what the try showed, at which head. Then it is Martin's to merge.

Try a part alone, early, only when a later part's design turns on what it shows, or when the parts are independent. Work with nothing to see on the cluster (docs, a test, CI, a skill) goes straight to its pull request.

## Reviews

Each pull request is reviewed once by each of `/code-review`, `/security-review` where the change bears on security, and Copilot, asked for as it opens ([`worker.md`](worker.md#steps)); again only when a fix changed the design.

A change that lets something merge, deploy or pass a check with nobody looking starts from a threat model in its brief: who could abuse it, how, and the positive check that answers them. It is allowed because the code proves it made or computed it, never by a name, label or branch. It gets two independent reads, yours to send, and no third: a fresh sub-agent given the diff, the plan's statement and the threat model, never the author's conclusions, shows each bypass as a failing test, which the worker fixes and commits; the second read follows the fixes. If it shows a bypass, the pull request stops and the design goes to Martin: the guard is the wrong shape. A redesign after a stop gets one read of its own; a fix within a read's findings, none.

## Each work item

1. **Brief** a fresh sub-agent to follow `${CLAUDE_SKILL_DIR}/worker.md`, with the key, the issue or brief's path, the run directory, the scripts' path, and what you know of overlaps with other items. For work to try before review, say build-only, or, after the try, that it finishes a branch already built, with what the try showed.
2. **Wait for it to end, not only to report.** Go on only when its task notification says it finished and `ListAgents` shows nothing of it still running; `TaskStop` any that is. Forward findings a worker's reviewer sends you by mistake to that worker, with SendMessage; a report it already gave stands only once it has dealt with them: verify and log it again.
3. **Verify** before you log or say anything: `verify.sh <key> <pr>` for each pull request (`verify.sh <key>` for a skip); for `built`, that `git ls-remote` shows its head and it has no pull request; for `opened`, that `verify.sh` fails only on Copilot and code scanning. A pull request is not ready while Copilot may still review or code scanning has not analysed its head, nor with an alert open on it unless the report drafts its dismissal, which goes to Martin. Where the report and the script disagree, the script wins: log what is true, and say so.
4. **Settle what it handed back.** A `split` or a `found` is yours to decide ([Finishing the work](#finishing-the-work-not-filing-it)).
5. **Log** the verified outcome and your decisions where the run keeps its notes (`<run dir>/NOTES.md` unless the session keeps them elsewhere).
6. **Retry or move on.** Stop a sub-agent that failed, stopped partway or reported something untrue before anything else touches its worktree; a new one may take it over, briefed with what is there. A build-only worker that stops without reporting, its branch pushed and its worktree clean, is stopped and logged as built once you have read its diff against the brief; the worker that finishes it runs `make check` first.

Never run two sub-agents on one worktree. Independent items with disjoint files may run in parallel; say so in the notes.

The merge queue tests each pull request on `main` as it will be, so one behind `main` needs nothing. When Martin merges one, a pull request that now conflicts takes `origin/main` by a merge, from a sub-agent briefed with what merged, which starts from `main`'s side where the conflict is on the merged change. Once its checks and `verify.sh` pass again, tell Martin it is ready.

An issue whose pull requests all say `Part of #<n>` is closed once the last merges, with a comment naming them and how it was proved.

## Stacks

GitHub's stacked pull requests work here with the merge queue and the review gate ([ADR 0014](../../../docs/architecture/adr/0014-merge-queue-and-review-gate.md)), in both repositories; a stack never spans the two. Use one only as [Before starting](#before-starting) says, never to tie independent work together: a failing entry in the queue takes those above it out too.

- **Making one.** Each branch is made from the one below (`worktree.sh <key> <branch> origin/<branch below>`) and its pull request opened into it (`gh pr create --base <branch below>`), its description naming the one below. `gh stack link <bottom> … <top>` links them once two are open, and `gh stack link <stack> <pr>` adds one to the top. The summary gives the stack's number.
- **Keeping it current.** When a lower branch changes, or `main` conflicts with any branch, merge upwards, bottom first: `origin/main` into the bottom only on such a conflict (GitHub runs no checks on that branch or those above), then each branch into the one above, each by its own worker, briefed with what changed below. Merges, never rebases or force-pushes, so review threads keep their lines: not `gh stack sync` or `gh stack rebase`. If a lower pull request merges alone, GitHub retargets the next to `main`, which shows the merged change again until `origin/main` is merged into it; the ones above take it in turn.
- **Answering review in one pass**, not a push and a rebuild of everything above for each pull request:
  1. Send each worker, bottom first, to open its pull request and stop ([`worker.md`](worker.md#stacks)), the next as soon as the one below is pushed.
  2. Wait until Copilot has reviewed them all (`copilot.sh <pr> <key>`), or its hour is over, or it was never asked. Gather every finding across the stack, from threads, summaries and failed checks, and give each to its branch: a finding on one pull request can be about a change below it.
  3. Send each worker, bottom first, with its branch's findings and the threads a branch below fixed (with the commit), to answer them, fix the rest, merge the branch below into its own and push once. A check a fix then fails is found in [After the last work item](#after-the-last-work-item).

  After that, a branch moves only when it conflicts with `main`.
- **Merging it** is Martin's: `gh stack merge <stack> --squash`. If an entry fails, it and those above it leave the queue, and he queues them again.

## Finishing the work, not filing it

The run exists to close work, not to find more. When a sub-agent says the work is bigger than its item, or reports something found on the way:

1. **The same pull request**, when doing the item properly needs it: a doc or test that changes with it, a file CODEOWNERS gives Martin, a stale comment it touches. Send a sub-agent back to finish it.
2. **A second pull request on the item** (`<key>-2`, `Part of #<n>`), when it is too big or mixed for one review. A worker opens it; if one reports a `split` instead, queue it next.
3. **A new issue**, only for a different problem the item does not need solved, such as a fault that predates it: filed to `.claude/skills/issue/SKILL.md`'s standard, on its milestone, then added to the end of this run. A work item Martin named leads to one new issue at most, and one the run filed leads to none; anything more goes in the summary, for Martin to file or drop.

Something that needs Martin's decision, or cannot merge until something else is deployed, goes in the summary, not an issue.

## Work a worker cannot do

A worker skips what needs an image pinned first, a migration with an ordered rollout, or the local cluster. When the plan or the brief names such work, it is yours:

- **A `deploy/` change that waits for an image**: in the summary with what it waits for, and made in a later run, once Martin has merged the change that builds the image and the App's deploy pull request that pins it. Only the App's deploy watch opens a pin's pull request (ADR 0005).
- **A proof or drill on the local cluster**: run with `try-the-line`, time-boxed, on the built branches' images before the pull requests open; one that needs the deployed version runs after the deploy, and says why. Log what it showed; until then it is in the summary.
- **Trying it with Martin**: only what needs a person, as soon as the work runs on the cluster, a few at a time, each with what to look for. A fault in the item goes back to it; anything else is held to [Finishing the work](#finishing-the-work-not-filing-it).

A pull request of your own gets every step a worker's does ([worker.md](worker.md#steps)); brief a worker for it when you can. Small is no reason to skip a step.

## After the last work item

With more than one pull request, a fresh sub-agent reads them all together against `docs/REVIEWERS.md` (the app's, for its repository) for changes that conflict, duplicate each other, or would break `main` in some merge order, and fixes each on the pull request it belongs to. Wait for it to end. Then every pull request's checks pass, `verify.sh` passes again, no thread is open but the arguable ones and other reviewers', and Copilot's review summary has its answer.

Write `<run dir>/SUMMARY.md` and give it to Martin, leaving out what does not apply: each work item's pull requests, or why it was skipped, and what the run filed or found; the merge order, and why; each file CODEOWNERS gives him that changed, and why; the decisions made on his behalf, the open threads, and each alert's drafted dismissal with its command; and what is left after a merge (a pin, a deploy change, a decision of his).

Done means every work item, and every issue the run filed, has open pull requests with passing checks, verified, or a written reason for skipping it.
