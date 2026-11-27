# 0025: Martin's stops hold where each move is made, a move lands only content the scan has known a day, and the risks that stay

Martin decided these on 26 November 2026, after reading autonomous patching (ADR 0022, ADR 0023) as someone would who held the factory's App's key, a publisher's account, or a comment box.

## Decision

### Three rulesets

`scripts/github-settings.ts` gives each repository two rulesets beside `main`'s (ADR 0014).

- **`branches`: only Martin and Dependabot create, update or delete a branch that is not the automation's.** The automation's are a list that imports nothing (`AUTOMATION_BRANCHES`, `policy/branches.ts`): `main`, everything under `factory/`, `deploy/local`, release-please's and the merge queue's own. Martin and Dependabot are exempt, so the ruleset is not run for their pushes and none is recorded as a bypass.
- **The gate passes nothing as Martin's from an automation branch.** `martin-opened` holds only for a branch the ruleset keeps for him (`automationBranch`), so the two halves meet: where the App's key can write, a pull request is judged as the App's change, and where a pull request passes as his, the App's key cannot write. The patching harness holds it on the scratch copies (its test N10): GitHub refuses the App's commit to a branch Martin made.
- **`tag main`: nobody makes, moves or deletes a tag named `main`.** The scan's runs are found by the name of the ref they ran on, and a run on such a tag would carry the branch's name.

### Martin's stops, and where each is enforced

| His stop | Enforced by | How |
|---|---|---|
| He asks for changes on a pull request | the review gate | No rule after `martin-opened` passes it, an exact pin and a move among them, at any head: a push leaves his review standing. His approval ends it, or his own dismissal of it; a dismissal by anyone else, or one whose author the gate could not read, ends nothing |
| He stops the line | the GitHub worker | It queues no move and no workflow pin of Dependabot's, as at Supervised. It reads his latest `line.started` or `line.stopped` as `factory_github` (migration 0055); unreadable is stopped. The local deploy pin, which runs only what he already merged, keeps flowing |
| He takes a head out of the merge queue | the GitHub worker | That head stays out, by GitHub's record of the removal (`manual`, or a person as its actor), across restarts. A removal the queue made itself goes in again, three times in all |
| He closes a pin pull request | the GitHub worker | It is not opened again for the same edits. Only his close holds, by his id: one anyone else closed is opened again |
| He undoes a move's merge on `main` | the GitHub worker | The move is left unmade until its target changes, with one issue. A group the pin step made waits whole |

Everything else the worker says or finds on GitHub it holds to its own hand: only the App's own comments count as already said, and a work item's issue is found by the mark the line wrote in it before another is opened.

### What a move may be

- **Content waits a day.** A tag's digest and a chart's version are whatever their publisher, or whoever holds the account, pushed last, and neither has pnpm's or mise's release age. No move, a fix as much as a routine update, lists at content the scan first saw less than a day ago (`ROUTINE.contentDays`, with two hours' slack for a daily scan that starts early). The move lists at the newest digest that has waited.
- **The scan's sealed record ties a digest to its tag.** A tag rebuilt since no longer serves the digest that waited, so the pin step and the gate do not ask the registry what the tag is today: they ask only that it still serves that digest under the image's repository. That the tag served it, and when, is the sealed state's word (ADR 0021).
- **A fix must be better than the pin.** An image's or a chart's release is a fix only when it has fewer findings than the pin, counted worst severity first through every severity. A release that clears one finding and brings another as bad is none.
- **Within the major first.** One pin's move goes to the furthest target within its major. What only a major clears is counted in what the move leaves, the deadline is the earliest of both, and the major lists once the pin has moved.
- **Never a pre-release,** and a kept target must still be listed and served by its registry.
- **A move is written only on its own pin.** The pin watch and the gate write by one function (`ownEdit`), which refuses a line `main` has since given another pin, and two moves on one line.
- **A scan is a judgement for a day and a half.** One judged more than 36 hours ago (`SCAN_MAX_AGE_HOURS`), or dated in the future, passes nothing; what would pass by it waits, and Martin is told the scan has stopped (`PatchingScanStale`).
- **The Claude Agent SDK waits for its bench** (`BENCHED`). A fix of it that clears a Critical is a move like any other. A lower one is an issue with its deadline, marked `bench`, which the gate makes for nobody: Martin runs the bench and moves it.
- **`waiting` says what is held.** `moves.json` lists each pin whose fix or routine update exists and is no move that day, with why: `content`, or `no-better`. No reader takes a finding no move lists for one fixed: Verify clears none that waits, and the pin watch leaves open a pull request whose move waits for its content.

## Why

- **The App's key should buy only what the gate proves.** `martin-opened` trusted a branch, and the App may write branches. Narrowing the App's permission would have taken its own branches from it; a ruleset takes only Martin's.
- **A stop that a restart forgets is no stop.** Each is read from GitHub's or the store's own record, never from the worker's memory, and each fails closed: an unread stop is a stop, an unknown hand on the queue is a person's.
- **Changes requested belong to the gate** because the gate already reads his reviews, with the review App's key and none of the factory's. The other four are acts on the worker's own pull requests and the queue, which only the worker watches.
- **A day, because it is the wait every other pin already has.** pnpm holds a release a day by default; an image had nothing. A day costs a fix a day of its deadline's start, not of its deadline: the clock starts when the wait ends.
- **Not a second look at the registry.** Asking what the tag serves at merge would refuse every tag rebuilt daily, which are the ones most in need of the wait.
- **Better than the pin, because a move's cost is real** and a trade of one finding for another buys nothing with it.
- **Within the major, because the smaller move merges at Guarded** and clears what it can while the major waits for Lights-out or Martin.
- **`waiting`, because absence was read as success.** A fix held for a day vanished from the moves, and three readers each took that for fixed or gone.

## Risks accepted

Each is Martin's decision to accept, stated so a reader need not find it, with what bounds it.

1. **The gate's check is green for a major at every level.** The hold at Guarded is the worker's alone, so the App's key alone could queue an exact major. What bounds it: the change is still exactly the scan's move, and the gate reads no level so that the level is kept in one place (ADR 0022).
2. **His dequeue, his close and his revert are the worker's to honour.** Whoever held the App's key could open the same move from another `factory/` branch and queue it; changes he asked for are one pull request's, so the same holds for them. What bounds it: what merges is still only the scan's move, made by the gate and compared byte for byte.
3. **The workflow-pin door is transitive.** What reaches the factory's `main` unattended, a move among it, then judges the app once Dependabot's bump of the pin is queued (ADR 0023). What bounds it: every such change passed the factory's own gate and required checks, and the bump must leave each workflow declaring the same to its caller.
4. **Kyverno, Argo CD and Argo Rollouts are moved as routine updates,** hold rights across the whole cluster, and run in namespaces admission control does not guard. Nor is admission control a brake on any third-party image's move: the digest it admits follows the pin. What bounds it: the wait, the content's day and the required checks, the cluster made from the change among them. Nothing else does.
5. **The packages the GitHub worker and the gate's own job import wait three days like any other.** What bounds it: the job that holds the review App's key imports no package; the `move` job, which does, holds only the scan's state key and takes it out of its environment before any of them is evaluated; the worker, which holds the factory's App's key, has the wait and pnpm's guards and nothing more.
6. **The factory has no canary and no rollback of a move that passes its checks.** A move Martin reverts is not made again, and that is all. What bounds it: the required checks, and Martin's revert, which the worker honours. The app has both a canary and a rollback.
7. **The issue is the disclosure point.** A move's package and advisory are public from when its issue opens, before its fix merges. What bounds it: nothing; Dependabot's own pull request would make them public the same way.
8. **`moves.json` is not sealed whole.** Held to the sealed state are its counts, its moves' places, and of its waiting list each result's place, how many wait at each pin, the target and the day of a wait for content, and a routine update's pin and target. The artifact's own are its judged time, its scanned images, and of a waiting entry the name and pins of one whose findings wait, a refusal as `no-better`, how its count divides, its deadline and a routine update's `until`, as a move's name, pins, target and deadline are where it is no lockfile's and not routine. What bounds it: the artifact is read only from a run of the scan on `main`, a time still to come is refused, and a move is written only where the line still holds what the move is from.
9. **One reverted package holds its lockfile group** until its target changes, since the pin step makes the group whole. What bounds it: each of the group's other moves says so in an issue of its own, and any can be made by hand.
10. **A dequeue holds one head.** When `main` moves, the pin watch writes a new head, which is queued. What bounds it: asking for changes, or closing, is the lasting stop, and the worker's comment on the dequeue says a new head starts again.
11. **A verdict pending for an old scan waits for something to run the gate again.** The worker's pull requests get it when the next scan rewrites their descriptions; the line's pull request does not, and the line holds it for Martin as having no verdict. What bounds it: the hold says what the gate waited for.

## Consequences

- A fix of an image or a chart lists a day later than it did, and a run with no state starts that wait for every one.
- A pin with a fix in its major and a major beyond takes two moves and two scans.
- A scan that stops holds every move in both repositories within 36 hours, and nothing else: a change it refuses is refused as it is.
- The drift check fails on any ruleset it does not know, and on any bypass actor but the two `branches` names.
- A session at Martin's `gh` pushes as him, so the `branches` ruleset does not hold an agent he runs.
- This decision amends ADR 0014, whose `martin-opened` does not hold on an automation branch and whose every later rule his requested changes hold; ADR 0017, whose pin queue reads the stop; ADR 0021, whose state keeps content's first sight and what waits; ADR 0022, whose scan has an age, whose moves are written on their own pin, and whose brakes do not count admission control; and ADR 0023, whose routine updates wait for their content and whose workflow pin is read at the queue's commit.
- `AGENTS.md`'s rules on merging name the stop, changes requested, the rulesets and the bench.
