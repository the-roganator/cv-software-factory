---
name: implement
description: Take issues, or a part of this conversation, to pull requests ready for Martin to merge, through sub-agents, each report checked before it is believed.
argument-hint: "#123 [#456 …] | <what from this conversation>"
disable-model-invocation: true
---

# Implement work items to pull requests

The work: `$ARGUMENTS`: one or more issues (`#123, #456`), something from this conversation (`the station order part`), or a mix. Take each to open pull requests ready for Martin to merge, or skip it with a reason.

You are the orchestrator. Keep your context lean: sub-agents do the work, each following [`worker.md`](worker.md). Make the calls you would otherwise ask Martin for, and write each one down. The scripts are in `${CLAUDE_SKILL_DIR}/bin/`; give sub-agents that absolute path, since their worktrees may not have this skill.

## Before starting

1. **Key each work item.** An issue's key is its number, and its second pull request `<n>-2`; a brief's is a short slug (`station-order`). A work item whose pull request is in the app's repository (`the-roganator/cv-worlds-worst-website`, checked out beside this one) has a key beginning `app-` (`app-flag-context`, or `app-<n>` for this repository's issue `<n>`): the scripts read the repository from the key.
2. **Make the run directory**: `run.sh <key>...` makes `scratch/implement/<date>-<keys>/` and prints its path. Briefs, notes, PR notes and the summary go there. What waits on Martin (the pull requests to merge, in order, with what to look at, and what to try once deployed) the session tells him in its reply. A later session carrying on the same work takes up the same directory rather than making another.
3. **Write each brief from the conversation** to `<run dir>/brief-<slug>.md`. The sub-agent sees nothing of this conversation, so the brief stands alone: **Goal** (the change and why, in a paragraph), **Agreed** (every decision Martin made or accepted, in his terms, and every option turned down), **Scope** (the files, components and docs named, and what is out), **Open** (what the sub-agent settles and reports), **Related** (issues, pull requests, commits). Write down what was said, not what you would add. If the conversation left open a decision that changes what gets built, ask Martin now, in one question.

   A brief for the app's repository carries this rule, in these words: nothing written in the app's repository, in code, commits, branch names, pull requests or replies, mentions or hints at seeded defects or faults. A brief says when the plan asks for `/security-review`.

   For work that changes what runs on the cluster, design it by tracing the whole path it opens, not only the part it changes: what runs after it, with what input, and whether that has ever run. A part that never has is named in the brief and in the try's proof.
4. **Order the work.** Read every issue far enough to brief it, and note work items that touch the same files or depend on each other, ordering them so that one another builds on goes first. Independent items each branch from `origin/main` and merge in any order. Pull requests that build on each other's unmerged work go in a [stack](#stacks) rather than wait for Martin to merge the one below: tell the worker the branch to build on. Never chain independent items to start them sooner. A piece several items need is a small item of its own, done first; only the first item that uses it can stack on it, and the others branch from `main` once it merges. A pull request that needs one in the other repository merged first cannot stack on it: its description says so, and the summary gives the merge order and any `deploy/` pin between.

## Try before review

Reviews pass faults that only running the work shows, and a fault in one part of a task often shows only once the part before it runs. So work that changes what runs on the cluster (the line, its agents, the workers, the console's actions) is tried on the local cluster first, and reviewed once, after:

1. **Build.** Brief each worker build-only ([`worker.md`](worker.md#build-only)): it builds its branch, stacked on the one below, with tests and `make check` green, and reports `built` with its head. Check `git ls-remote origin <branch>` shows it.
2. **Try.** Once every part is built, make every branch current, bottom first, each by its own worker: `origin/main` into the bottom, even with no conflict, and each branch into the one above, so the images tried are what will merge: the one time a branch takes `origin/main` only to be current. Build the images from the top branch and run the plan's or the brief's proof with the `try-the-line` skill, time-boxed. Send each fault back to its branch, to a worker briefed build-only with what the try showed (the one who built it, or a new one on its worktree), merge it upwards, and try again until the proof passes. Log each try, what it showed, and where each fault went.
3. **Batch Martin's part.** What needs a passkey goes into one short sitting with him, with a list of what to do and what to look for. Where an agent's step is what is being tried, try it on the bench first, where no passkey is needed; only what the bench cannot show needs the cluster.
4. **Finish.** Send each worker, bottom first, to finish its pull request from the built branch: its reviews, `/visual-pr`, the pull request, then Copilot, once each, answered across the stack in one pass ([Stacks](#stacks)). Its description says what the try showed, at which head, and what review changed since. Then the stack is Martin's to merge, and the try on the cluster after the deploy is his ([Work a worker cannot do](#work-a-worker-cannot-do)).

Try a part alone, early, only when a later part's design turns on what it shows, or when the parts are independent. Work with nothing to see on the cluster (docs, a test, CI, a skill) goes straight to its pull request.

## Each work item

1. **Brief** a fresh sub-agent to follow `${CLAUDE_SKILL_DIR}/worker.md`, with the key, the issue or brief's path, the run directory, the scripts' path, and what you know of overlaps with other items. For work to try before review, say build-only, or, after the try, that it finishes a branch already built, with what the try showed.
2. **Wait for it to end, not only to report.** A sub-agent can report while its own background work still runs. Go on only when its task notification says it finished and `ListAgents` shows nothing of it still running; `TaskStop` any that is. Forward findings a worker's reviewer sends you by mistake to that worker, with SendMessage; a report it already gave stands only once it has dealt with them: verify and log it again.
3. **Verify** before you log or say anything: `verify.sh <key> <pr>` for each pull request (`verify.sh <key>` for a skip); for `built`, that `git ls-remote` shows its head and it has no pull request; for `opened`, that `verify.sh` fails only on Copilot. A pull request is not ready while Copilot may still review. Where the report and the script disagree, the script wins: log what is true, and say so.
4. **Settle what it handed back.** A `split` or a `found` is yours to decide ([Finishing the work](#finishing-the-work-not-filing-it)).
5. **Log** the verified outcome and your decisions where the run keeps its notes (`<run dir>/NOTES.md` unless the session keeps them elsewhere).
6. **Retry or move on.** Stop a sub-agent that failed, stopped partway or reported something untrue before anything else touches its worktree; a new one may take the worktree over, briefed with what is actually there; otherwise note it and go on.

Never run two sub-agents on one worktree. Independent items with disjoint files may run in parallel; say so in the notes.

Pull requests merge through GitHub's merge queue, which tests each on `main` as it will be, so one behind `main` needs nothing. When Martin merges one, move only what the merge forces: a pull request that now conflicts. Send a sub-agent to merge `origin/main` into it and resolve, briefed with what merged (it owns the worktree for that); where the conflict is on the merged pull request's own changes, it starts from `main`'s side and carries its own changes over. In a stack the branches above then take the change, bottom first. Once its checks and `verify.sh` pass again, tell Martin it is ready.

An issue whose pull requests all say `Part of #<n>` stays open after the last merges: keep it in view until then, and close it, with a comment naming its pull requests and how it was proved.

## Stacks

GitHub's stacked pull requests work here with the merge queue and the review gate ([ADR 0014](../../../docs/architecture/adr/0014-merge-queue-and-review-gate.md)), in both repositories; a stack never spans the two. Use one wherever pull requests build on each other's unmerged work, and never to tie independent work together: a failing entry in the queue takes those above it out too.

- **Making one.** Each branch is made from the one below (`worktree.sh <key> <branch> origin/<branch below>`) and its pull request opened into it (`gh pr create --base <branch below>`), its description naming the one below. `gh stack link <bottom> … <top>` links them once two are open, and `gh stack link <stack> <pr>` adds one to the top (`gh extension install github/gh-stack` if missing). The summary gives the stack's number.
- **Keeping it current.** When a lower branch changes, or `main` conflicts with the bottom, merge upwards, bottom first: `origin/main` into the bottom only if it conflicts, then each branch into the one above. Each branch is its own worker's, so send them one at a time, bottom first, each briefed with what changed below. Merges, never rebases or force-pushes, so review threads keep their lines: not `gh stack sync` or `gh stack rebase`. If a lower pull request merges alone, GitHub retargets the next to `main`, which shows the merged change again until `origin/main` is merged into it: send its worker to do that, and the ones above take it in turn.
- **Answering review in one pass.** Answering Copilot on the bottom pull request, pushing, rebuilding everything above, then doing the same for the next, costs CI and the queue's time for nothing. Instead:
  1. Send each worker, bottom first, to open its pull request and stop ([`worker.md`](worker.md#stacks)), the next as soon as the one below is pushed, without waiting on its CI.
  2. Wait until Copilot has reviewed them all (`copilot.sh <pr> <key>`), or its hour is over. Gather every finding across the stack, from threads, summaries and failed checks, and decide the branch each belongs to: a finding on one pull request can be about a change below it.
  3. Send each worker, bottom first, with its branch's findings and the threads a branch below fixed (with the commit), to answer them, fix the rest, merge the branch below into its own and push once. Nobody waits on CI after it; a check a fix then fails is found in [After the last work item](#after-the-last-work-item).

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
- **Trying it with Martin**: as soon as the work runs on the cluster (synced and healthy), not all at the end, give him a short list of what to try and what to look for, a few at a time. A fault in the item goes back to it; anything else is held to [Finishing the work](#finishing-the-work-not-filing-it).

A pull request of your own gets everything a worker's does; brief a worker for it when you can: the reviews, by fresh sub-agents invoking the skills as [worker.md](worker.md)'s step 4 says, `/visual-pr`, Copilot's threads and summary, and `verify.sh`. Small is no reason to skip a step.

## After the last work item

With more than one pull request, a fresh sub-agent reads them all together against `docs/REVIEWERS.md` (the app's, for its repository) for changes that conflict, duplicate each other, pull in different directions, or would leave `main` broken in some merge order, and fixes each on the pull request it belongs to. Wait for it to end. Then every pull request's checks pass, `verify.sh` passes again, no thread is open but the arguable ones and other reviewers', and Copilot's review summary has its answer.

Write `<run dir>/SUMMARY.md` and give it to Martin, leaving out what does not apply: each work item's pull requests, or why it was skipped, marking the issues the run filed and what it found but left unfiled; the merge order, and why, with any update a merge will force on another; each file CODEOWNERS gives him that changed, and why; the decisions made on his behalf and the open threads; and what is left after a merge (a pin, a deploy change, a decision of his).

Done means every work item, and every issue the run filed, has open pull requests with passing checks, verified, or a written reason for skipping it.
