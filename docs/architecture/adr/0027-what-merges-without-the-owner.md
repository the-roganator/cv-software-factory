# 0027: What merges without the owner

## Decision

A change of the factory's own merges with nobody's hand on it only when three questions each have a yes:

1. **Is it exactly a change the factory may make alone, and nothing else?** The review gate answers this.
2. **Did every required check pass?** The head must pass them, and the merge queue runs them again on its own commit.
3. **Does the owner's autonomy level allow it?** One table answers this for everyone who queues.

Every other change waits for the owner. The mechanics are in [Approval routing](../../COMPONENTS/APPROVAL-ROUTING.md), [the GitHub worker](../../COMPONENTS/GITHUB-WORKER.md) and [Repositories and rulesets](../../COMPONENTS/REPOSITORIES-AND-RULESETS.md).

### The gate passes exactly the scan's moves

The gate does not judge whether an update is safe. The daily scan has already decided what each pin moves to ([ADR 0026](0026-the-daily-scan-decides-every-move.md)). The gate makes that same move itself, on `main`, the way the scan made it, and compares the result with what the pull request would merge, byte for byte. A pull request may carry several of the day's moves, but each must be whole. Anything extra, missing or different holds it, with a reason that says where.

- **It reads nothing the pull request says about itself,** such as its title, label or branch. The moves come from the scan's newest run on `main`.
- **It runs nothing the pull request carries.** The work is done in a job of its own, with read-only permissions and only the scan's state key. The pull request's commits are fetched as data. The job that holds the review App's key reads no head.
- **It names what it found, and reads no level.** It passes a move as `move`, or as `major` when the move crosses a major version and clears no Critical. An image the factory builds passes only as an exact pin.

### One table of levels

The line and the GitHub worker both ask one table (`ENQUEUES` in `policy/line.ts`), and only while auto-merge is on:

| | Supervised | Guarded | Lights-out |
|---|---|---|---|
| `move` | waits | queued | queued |
| `major` | waits | waits | queued |

Controls the worker cannot read count as Supervised with auto-merge off.

### The worker queues only its own watches' work

The GitHub worker holds the one key that can add a pull request to the merge queue. It adds three kinds, each found by a watch of its own, at the head the gate judged:

- **This repository's local deploy pin,** at every level. It only points the local cluster at an image `build.yml` already built and signed from `main`, so merging it decides nothing new.
- **The scan's moves,** in this repository, as the level allows. Only the pin watch's own pull request, at the commit the watch itself wrote, is added.
- **Dependabot's bump of the factory's workflows in the app.** The app calls the factory's gates at a commit of the factory's `main`. When Dependabot moves that commit forward, and every called workflow still asks its caller for the same inputs and secrets, the gate passes it as an exact pin and the worker queues it at Guarded and Lights-out.

It also closes one kind of pull request: Dependabot's, once `main` already has every line it adds. It closes it with one comment, naming the pull request or commit that brought the lines in where git's blame gives it. A pull request it closed and someone opened again is left alone.

Nothing else is queued this way: not a pull request the gate held, even once the owner approved it, nor a release, an improvement or another deploy profile's pin. A queue failure or a failed check that may be a flake is retried, three times in all, and then the pull request is left to the owner with a comment.

### The factory cannot change what judges it

The factory's App has no permission to write workflows. No workflow opens, approves or queues a pull request. Every other workflow pin, and every third-party action, is the owner's to move.

### The owner's stops hold, and fail closed

Each stop is read from a record GitHub or the event store keeps, never from the worker's memory, so a restart forgets none. A stop that cannot be read counts as a stop.

| The owner's stop | What it does | Held by |
|---|---|---|
| Asks for changes on a pull request | No rule passes it without the owner, at any head, until the owner approves it or dismisses the review. A pull request the owner opened is the owner's own, and is not held by it | the gate |
| Stops the line | The worker queues no move and no workflow bump, as at Supervised. The local deploy pin still flows | the worker |
| Takes a head out of the merge queue | That head stays out. A new head starts again | the worker |
| Closes a pin pull request | It is not opened again for the same edits | the worker |
| Reverts a move on `main` | The move is not made again until its target changes, and one issue says so | the worker |

Two rulesets back these up in each repository. Only the owner and Dependabot may create, update or delete a branch outside the automation's own (`main`, `factory/…`, `deploy/local`, release and queue branches). The gate passes nothing as the owner's own change from an automation branch. So where the App's key can write, a pull request is judged as the App's; and where a pull request passes as the owner's, the App's key cannot write. A third ruleset forbids a tag named `main`, since the scan's runs are found by the name of the ref they ran on.

## Why

- **An approval adds nothing to a move the scan proves is needed.** The owner would approve every one, and cannot judge a digest or a lockfile by eye, while each day of waiting is a day exposed.
- **"Exactly the scan's move" is a question a gate can answer.** Whether an update is good is not. Whether a pull request is a given move and nothing else is, by making the move and comparing bytes. A pull request shaped to look like a move is not those bytes.
- **The checks prove what is theirs to prove.** Whether a move breaks something is what the required checks test. Whether it brings a new finding is the next scan's to find, and that scan moves it too. A gate that scanned and rendered again would be a weaker second copy of each.
- **One table, so a level means one thing.** A second setting for moves would be a second place the owner must keep in step.
- **The worker, not the line.** The factory's own deploys and pins carry no work item, so the line never sees them. The worker already opens them, holds the only key that queues, and works while the line is stopped.
- **Not GitHub's auto-merge,** which queues whichever head next meets the rules. Queuing a judged head names the head.
- **No workflow permission for the App.** The workflows hold the gates and the only secrets in Actions. An App that could write them could rewrite what judges it. Dependabot already writes the one workflow change the factory queues, and the gate proves it is that change and nothing else.
- **Closing a duplicate is right exactly when `main` has its lines.** Closing tells Dependabot not to propose those versions again. Reading `main`'s files, rather than versions in a title, needs no rules for each ecosystem. A pull request that still moves anything has a line `main` lacks, and stays open.
- **A stop a restart forgets is no stop.** So each is read from its record and fails closed. Requested changes belong to the gate, which already reads reviews; the rest are acts on the worker's own pull requests.

## Risks accepted

Each is accepted knowingly, with what bounds it.

1. **A real upstream release that is itself bad can merge.** A chart that widens permissions, an image whose publisher was compromised, or a package that fixes the finding and ships something else passes if it is exactly the scan's move and its checks pass. An approval would not have caught it either. What bounds it: the waits ([ADR 0026](0026-the-daily-scan-decides-every-move.md)), pnpm's guards and mise's release age, the required checks on the head and in the queue, a fix having to be better than the pin, and in the app the canary's analysis and rollback.
2. **The gate's check is green for a major at every level.** The hold at Guarded is the worker's alone, so the App's key alone could queue an exact major. What bounds it: the change is still exactly the scan's move, and the gate reads no level so that the level lives in one place.
3. **The owner's dequeue, close and revert are the worker's to honour.** Whoever held the App's key could open the same move from another `factory/` branch and queue it. Requested changes hold one pull request, so the same is true of them. What bounds it: what merges is still only the scan's move, made by the gate and compared byte for byte.
4. **The workflow-pin door is transitive.** What reaches the factory's `main` unattended, a move among it, then judges the app once Dependabot's bump is queued. What bounds it: each such change passed the factory's own gate and checks, and the bump must leave every workflow asking its caller for the same.
5. **Cluster-wide controllers move as routine updates.** Kyverno, Argo CD and Argo Rollouts hold rights across the whole cluster and run outside the namespaces admission control guards. Nor is admission control a brake on any third-party image's move: the digest it admits follows the pin. What bounds it: the waits, and the required checks, including the cluster made from the change. Nothing else does.
6. **The packages the worker and the gate's job import wait three days like any other.** What bounds it: the job that holds the review App's key imports no package; the job that does holds only the state key, and removes it before any package loads; the worker, which holds the App's key, has the wait and pnpm's guards and nothing more.
7. **The factory has no canary and no automatic rollback.** A move that passes its checks is live. What bounds it: the required checks, and the owner's revert, which the worker honours. The app has both a canary and a rollback.
8. **A dequeue holds one head.** When `main` moves, the pin watch writes a new head, which is queued. What bounds it: asking for changes, or closing, is the lasting stop. The worker's comment on the dequeue says the head is the owner's to add again or close, and that a new head starts again.
9. **A verdict pending on an old scan waits for something to run the gate again.** The worker's pull requests get it when the next scan rewrites them; the line's does not, and the line holds it for the owner as having no verdict. What bounds it: the hold says what the gate waited for.

## Consequences

- An image built on `main` reaches the local cluster without the owner.
- A move the scan found reaches `main` without the owner, at the level the owner set. One the gate or the level holds waits, with its reason in the pull request.
- Dependabot's pull request for a pin the scan lists is closed once `main` has its lines, by Dependabot or by the worker. One the gate would pass is still the owner's to queue.
- An agent session run with the owner's own GitHub credentials pushes as the owner, so the branch ruleset does not hold it.
- The settings drift check fails on any ruleset it does not know, and on any bypass but the owner's and Dependabot's.
- Guardrail 10 (the factory acts only on what it opened) has two stated exceptions: the queue of Dependabot's workflow bump, and the close of Dependabot's duplicates.
