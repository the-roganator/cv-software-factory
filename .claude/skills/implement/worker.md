# Implement one work item to a pull request

You are a sub-agent. Your brief names one work item in `the-roganator/cv-software-factory`, its key, the run directory, the scripts' path, and what is known of overlaps with other work. The item is an **issue** (key `278`, or `278-2` for its second pull request; `gh issue view <n>`) or a **brief** (key a slug, described in `<run dir>/brief-<slug>.md`, written from a conversation with Martin you did not see: what it says was agreed is his decision, what it leaves open is yours). A key beginning `app-` has its pull request in the app's repository ([below](#a-work-item-in-the-apps-repository)).

Martin won't answer questions. Make the calls you would otherwise ask for, and write each one down for your report.

## Ownership

- You alone own `scratch/worktrees/<key>` and its branch. `worktree.sh` refuses (exit 3) if either exists: report `blocked`, unless your brief says you take it over.
- Nothing you start may outlive you: run every command and sub-agent in the foreground and wait for it, and leave no background task, watcher or sub-agent running. Your report is the last thing you do, and you change nothing after it.
- Leave the main checkout alone: other sessions use it. Never `git stash`, in any form: the stash is shared with every worktree. Set work aside with a commit.

## A work item in the app's repository

`worktree.sh` makes the worktree from the app's checkout (beside this one, or `APP_DIR`) at its `origin/main`, still under this checkout's `scratch/worktrees/<key>`, and `verify.sh` checks the app's pull request. Otherwise the steps are the same, except:

- **Nothing you write there mentions or hints at seeded defects or faults**: not in code, comments, tests, commits, branch names, the pull request or replies. Describe a fix by what the code did wrong and does now. Your report to the orchestrator may say what it needs to.
- The worktree sits inside this checkout, whose `node_modules` and `mise.toml` a command there would otherwise find: set it up first, in the worktree, as the app's `AGENTS.md` says (`mise install && pnpm install`). Follow its `AGENTS.md`, `docs/REVIEWERS.md`, `make check` (and anything else its `AGENTS.md` asks of a change like yours) and `.github/CODEOWNERS`, not this repository's.
- Name the repository in every `gh` command (`-R the-roganator/cv-worlds-worst-website`), except for the issue of an `app-<n>` key, which is this repository's (`gh issue view <n> -R the-roganator/cv-software-factory`): its pull request says `Closes the-roganator/cv-software-factory#<n>` (or `Part of`).
- Give reviewers the worktree's absolute path, to review `git -C <worktree> diff <base>...HEAD` against the app's `docs/REVIEWERS.md`. The note's first line names the worktree, so `/visual-pr` reads the app's template; run `gh pr create`, `gh stack link` and `.claude/skills/visual-pr/bin/check.ts --pr <pr>` (by this checkout's absolute path) in the worktree.

A pull request that needs one in the other repository merged first says so, naming it.

## Finish the item; don't file it away

Your job is to finish this item, not to find more work. Never open an issue.

- What the item needs to be done properly goes in this pull request: the docs and tests that change with it, comments it makes stale, files CODEOWNERS gives Martin.
- An item right but too big or mixed for one review gets a second pull request, from you, with every step again (`worktree.sh <key>-2 <branch>`, `Part of #<n>`), stacked on the first only if it builds on its unmerged work; report both as `pr-open`.
- If finishing needs work outside the item, stop at what is complete and report `split`, with each part and why it cannot be part of this item.
- Something unrelated you notice goes under `found`, with its file and line.

## Files CODEOWNERS gives Martin

These are the rules of the line, and a change to one merges only with his approval: a reason to make the change well, not to avoid it. When the work needs one changed, change it here (never leave one stale, or put off to an issue a change that belongs here), keep to what the work needs, and give each file a line in a section of the description of its own, under a heading that names CODEOWNERS: what changed and why. Say plainly if a change loosens a rule. `verify.sh` fails a pull request unless each such file has a line there, with words beside the path.

## Steps

Build-only stops after step 3; finishing a branch already built starts at step 4 ([Build-only](#build-only)).

1. **Worktree.** `worktree.sh <key> <type>/<short-name>` makes it from `origin/main` (a third argument, `origin/<branch below>`, for a [stack](#stacks)) and prints its path. Work and commit only there.
2. **Triage.** Read the issue or brief and the code it names. Report `skipped`, with a paragraph's reason, if it is invalid, done or a duplicate; if it needs a decision only Martin can make that neither the issue nor the brief settles (a change to the intent, a trade-off left open, a security flaw); or if it cannot merge on its own (an image pinned first, an ordered migration, the local cluster to prove it), unless your brief hands that part to the orchestrator: then build the rest and say so under `decisions`. That a file is code-owned is never a reason to skip.
3. **Implement.** Follow `AGENTS.md` and the docs it points to, with tests for the change. `make check` passes before going on, and `make e2e` too if the console changed (snapshots only in the pinned image, `make e2e UPDATE=1`).
4. **Review.** Brief a fresh sub-agent to invoke, with the Skill tool, the `code-review` skill, args `medium <branch>`, the branch always named, and the `security-review` skill too if the brief asks, or if a mistake would be a security hole (auth, secrets, admission, the network, the answer key). Tell it, in these words, to invoke each skill with the Skill tool, really invoking it, not reviewing in its style: told only to run `/code-review`, a sub-agent reviews its own way and never calls the skill. In a worktree `security-review` finds an empty diff, so tell its reviewer to have the skill review `git -C <worktree> diff <base>...HEAD`, `<base>` being `origin/main` or the branch below. Brief each reviewer to report to you alone what each skill returned. A report that does not show that is no review: brief a fresh reviewer, once; if it cannot invoke a skill either, report `incomplete`, saying why. Fix what holds up and belongs to the item; the rest goes under `found`. Review again only if a fix changed the design.
5. **Pull request.** Write `<run dir>/pr-<key>.md`, with the CODEOWNERS section if it applies, run `/visual-pr <base> <note>`, and open the pull request with the description it returns, attaching each SVG and screenshot it lists with `--attach` (on `gh pr edit --body-file` too), with the attribution folded as the skill's last lines show, then check it with `node .claude/skills/visual-pr/bin/check.ts --pr <pr>` (in the app's worktree, for an `app-` key). The title is a Conventional Commit. An issue's body says `Closes #<n>`, or `Part of #<n>` when another pull request completes it (both with `the-roganator/cv-software-factory` before the `#`, for an `app-` key); a brief's names any issue it touches without closing it.
6. **Copilot** reviews once, when the pull request opens, and may not review at all. `copilot.sh <pr> <key>` waits for it at most eight minutes at a time and lists unresolved threads: while it exits 5, run it again, in the foreground; 4 means no review. Answer each of Copilot's threads with `reply.sh <thread-id> <body>`: fixed (name the commit) or wrong (say why) resolve it; arguable takes `--open`, and is reported. A thread marked `NOT COPILOT` is someone else's: fix what belongs to the item, reply with `--open`, never resolve it, and report it. Then answer the review's summary, which can name findings with no thread, once, in a comment beginning `Copilot's review summary:` that quotes or names each such finding with fixed (the commit), wrong (why) or arguable (and report it), or says it adds nothing beyond the threads. Answer what it found, not its tally. Never request a review.
7. **Checks.** `gh pr checks <pr> --watch`. Fix a failure the change caused; report one it didn't. Before every push, here or in step 6, and again before step 8, `git fetch origin` and merge the branch from `origin` into the worktree, so a push neither fails nor overwrites someone's commit, and the worktree is at the pull request's head. If a push is still rejected, fetch and merge again; never force-push. The merge queue tests each pull request on `main` as it will be, so never merge `origin/main` only to be current. Only when the pull request conflicts with `main` (merge `origin/main`), or in a stack when the branch below changes (merge `origin/<branch below>`, as [Stacks](#stacks) says), merge it into the branch with a merge commit, so review threads keep their lines, resolve it, push, and wait for the checks again.
8. **Check yourself.** `verify.sh <key> <pr>` for each pull request (`verify.sh <key>` when skipped) exits 0 before you report, except as [Stacks](#stacks) says for `opened`. It fails while Copilot may still review.

Never merge, approve or push to `main`, and never enqueue a pull request or a stack. Keep the worktree until Martin merges.

## Build-only

Work that changes what runs on the cluster is tried there before review (the skill's [Try before review](SKILL.md#try-before-review)). When your brief says build-only:

- Do steps 1 to 3, commit, `git fetch origin`, merge the branch from `origin` if it is there, and push, so the branch above can be made from it and the orchestrator can build images. Then stop: no reviews, note, `/visual-pr`, pull request or Copilot. Report `built` with the branch and its pushed head.
- A fault the try found comes back to you, or to a new worker on your worktree, build-only again: fetch and merge the branch from `origin` first, fix it with a test that shows it, push, and report `built` again.

To finish a branch already built, take the worktree as your own (don't run `worktree.sh`), fetch and merge the branch from `origin` and the branch below if it changed, read what is on it, the fixes the try sent back included, check `make check` (and `make e2e`) again, then do steps 4 to 8, step 4's reviews of the whole branch, the note saying what the try showed, and report `pr-open`; in a stack, in the two passes below.

## Stacks

Only for pull requests that build on each other's unmerged work ([ADR 0014](../../../docs/architecture/adr/0014-merge-queue-and-review-gate.md)).

- Make the worktree from the branch below, and give `origin/<branch below>` to `/visual-pr` and the reviewers as the base, and `<branch below>` to `gh pr create --base`. The description names the pull request below. Once it is open, `gh stack link <bottom> … <top>` (the bottom one has nothing to link yet: the one above links both), or `gh stack link <stack> <pr>` to add yours to the top (`gh extension install github/gh-stack` if missing); put the stack's number in your report.
- When the branch below changes, merge `origin/<branch below>` into yours and push; only the bottom takes `origin/main`, and before a try takes it even with no conflict. The branches above are their own workers'. Never rebase or force-push: not `gh stack sync` or `gh stack rebase`.
- An open stack is answered in two passes, each bottom first:
  - Briefed to open your pull request: do steps 1 to 5 (from 4 for a branch already built), link it, and report `opened`, without waiting on CI or Copilot. `verify.sh` may then fail only on Copilot.
  - Briefed later with your branch's findings: answer the threads and the summary as step 6 says, naming the commit where a branch below fixed one; fix the rest; merge `origin/<branch below>` into yours (the bottom has none) and push once, without waiting for checks again. Then step 8, and report `pr-open`, with the checks as they stand.

## Report

State only what command output showed you, and say plainly when a step was not finished. Repeat `pr` to `head` for a second pull request. For `built`, `pr`, `stack`, `checks` and `threads` are `none`; for `opened`, `threads` is what `verify.sh` showed:

```
item:      #<n> | <slug>
outcome:   pr-open | opened | built | split | skipped | blocked | incomplete
pr:        #<n> <url>, or none for built
stack:     <its number and the pull requests in it, bottom first, or none>
branch:    <name>
head:      <short sha of the pushed HEAD>
worktree:  scratch/worktrees/<key>
checks:    <from gh pr checks>
owned:     <each file CODEOWNERS gives Martin that changed, and why, or none>
threads:   <open arguable threads, with links, or none>
decisions: <each call made on Martin's behalf, a line each>
split:     <each part proposed beyond this item, and why it can't be part of it, or none>
found:     <each unrelated problem noticed, with file:line, or none>
reason:    <for split, skipped, blocked or incomplete>
```
