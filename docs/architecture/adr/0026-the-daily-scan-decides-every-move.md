# 0026: The daily scan decides every move

## Decision

Every pin either repository runs is scanned every day (ADR 0013). The scan's answer is a list of **moves**. A move is one pin going from one version to another, with what it clears, its deadline, and who makes it. The scan decides each move once. Everything after it (the pull request, the review gate, the merge) only carries out that decision, and checks that it was carried out exactly ([ADR 0027](0027-what-merges-without-the-owner.md)).

The mechanics are in [Security scanning](../../COMPONENTS/SECURITY-SCANNING.md#moves) and [Patching](../../COMPONENTS/PATCHING.md).

### Two kinds of move

- **A fix** clears one or more known vulnerabilities. It has a deadline set by its worst finding: two days for a Critical, seven for a High (ADR 0013).
- **A routine update** clears nothing. It moves a pin that is merely behind, so that no pin goes stale for want of an advisory. It has no deadline and raises no alert.

Both are made, reviewed and merged the same way. A pin with a fix that day gets no routine update, and the two never share a pull request, so a failing routine update never holds up a fix.

### Where a move goes

- **Forward, and never to a pre-release.** A move goes to a release the registry still lists and serves.
- **Better than the pin.** A release is a fix only when it leaves fewer findings than the pin, counted worst severity first. A release that clears one finding and brings another as bad is not a fix.
- **Within the major first, as a rule.** Where a fix exists on the pin's own major version, the move goes there. What only the next major clears is counted as left behind, and the major is listed once the pin has moved.
- **A chart goes to its major when staying would leave worse.** If the worst finding only a chart's next major clears is strictly worse than the worst one the move within the major clears, the move is the major, and it clears everything. Only the worst on each side counts, never how many. A package always stays within its major first: a lockfile can hold several copies of a package, and the move goes to one version on each line a copy is on.
- **Never for what judges.** The toolchain (what mise pins) moves only for a finding or when someone upgrades it. Images the factory builds move by their deploy pull requests, not by the scan. A short list of pins is never moved as a routine update, each with its reason (`ROUTINE.leave` in `policy/vulnerabilities.ts`).

### How long a release waits

- **Content waits a day.** An image's tag and a chart's version are whatever their publisher pushed last, and they have no release age of their own. No move lands at an image digest or a chart version the scan first saw less than a day ago. Packages already have this wait from pnpm, and tools from mise.
- **A routine update waits three days, seven for a major,** on top of that. The wait counts from a date the publisher cannot write: npm's publish time, GitHub's publication of a k3s release, or for an image or a chart the day the scan first saw the release.
- **A fix does not wait those days.** Not patching is the danger there.

### Who makes each move

Each move has a **lane** that says who makes it:

- **The factory's App,** in this repository. One pull request carries the day's moves for a set of files. A major rides on its own, and routine updates ride apart from fixes.
- **The line,** in the app's repository, as a work item like any other.
- **The cluster,** for k3s: its pull request merges as any other, and `make upgrade-cluster` then applies it.
- **An issue, for the owner,** for what the App may not write (a workflow's pin) and for a fix of the Claude Agent SDK that clears no Critical. The SDK is the loop every agent step runs in, so its update waits for a live bench run.

No lane waits for Dependabot. Dependabot's security updates move direct dependencies only, read no chart, no k3s and no mise, and keep their own schedule. It still proposes what the scan does not list, such as the actions the workflows use.

A move that needs pnpm's resolver or mise (a lockfile's package, a tool) is made in the scan's own run, in a job that holds none of the App's keys. The App only commits the files that job made.

### What is held is said

A pin whose fix or routine update exists but is not a move today is listed as **waiting**, with why: its content has not waited a day, or no release is better than the pin. No reader takes a finding that no move lists for a fixed one.

### A scan is a judgement for a day and a half

A scan judged more than 36 hours ago, or dated in the future, passes nothing. What would have passed by it waits, and the owner is alerted that the scan has stopped.

### Its memory is a sealed artifact

The scan must remember things from one run to the next: the day each finding was first seen, the day each release was first seen, and what it decided. It keeps them in one file, uploaded as an artifact of its own run on `main`. The file is encrypted (AES-256-GCM) with a key each repository has of its own.

- **Sealed, because the runs are public.** Both repositories are public, so their artifacts are too, and the file names what is known to be vulnerable and not yet fixed. Without the key it shows its size and nothing else.
- **Trusted by where it is, not by what it says.** A reader takes a state only from a run of the scan on `main`, found the same way the day's `moves.json` is found. The seal keeps the file secret; it is not what makes the file trusted.
- **Code scanning stays the record.** Every finding is still an alert there. A scan with no state it can open reads the alerts once, so losing the state, or its key, moves no deadline.
- **Few hold the key.** The scan, its job that makes moves, the review gate's job that checks them, and the GitHub worker. The jobs take it in a single step and remove it from their environment before any dependency loads.

## Why

- **A patch that waits is unsafe too.** Each day a move waits, the factory runs something it knows is vulnerable. The deadline exists to end that exposure, so the decision of what to move is made by the scan, which can make it every day.
- **One mechanism for fixes and updates.** Both are a pin going from one version to another; a second path would be a second thing to keep right.
- **The wait is a cooldown.** Most malicious releases are pulled within hours. The first release of a major is the one most often followed by a fix: postgres.js 4.0.0 lost LISTEN after a failed reconnect, and 4.1.0 fixed it a week later.
- **Publisher dates are not trusted.** An image's build time and a chart index's `created` field are written by whoever publishes them, so a backdated release would skip the wait it exists for. The day the scan first saw a release is the only date nobody else writes.
- **A day, because every other pin already has one.** pnpm holds a package release a day by default; an image had nothing. The day delays the start of a fix, not its deadline: the clock starts when the wait ends.
- **Better than the pin, because a move costs something.** Each move costs a round of checks and a merge, and may break something. Trading one finding for another as bad buys nothing for that cost.
- **Within the major, because the smaller move merges sooner.** A move within the major can merge at the Guarded level, so it clears what it can while the major waits for the owner or for Lights-out.
- **A chart's major at once, because a small move must not delay a worse finding.** A chart release that clears only Lows would push the move that clears a High behind a second scan. A chart is one pin, so its major can be taken whole. A package cannot always: a copy that only another package brings in cannot cross a major without an override.
- **Waiting is listed, because absence reads as success.** A fix that waits and is not listed looks fixed to anything that counts open findings from the moves.
- **An artifact, not the alerts or a cache.** Reading the alerts back would mean paging about 10,000 of them, about 100 seconds each time, while they are still changing after an upload. A cache cannot be read from outside a workflow, and a pull request's run can restore one. One file, uploaded with `moves.json` on the same run, is one request and never out of step with it.
- **One key, and one for each repository.** The scan reads its own state, so it must hold the key that opens it either way; a key pair would add nothing. A key per repository keeps each scan from opening the other's.

## Risks accepted

1. **The issue discloses the vulnerability.** A move's package and advisory are public from when its issue opens, before its fix merges. Nothing bounds this. Dependabot's own pull request would make them public the same way.
2. **`moves.json` is not sealed whole.** Its counts, its moves' places and the waiting entries' key fields are held to the sealed state. Some fields are the public artifact's word alone, such as its judged time, a move's name and pins where it is not a lockfile's, and a deadline. What bounds it: the artifact is read only from a run of the scan on `main`, a time in the future is refused, and a move is written only where the file still holds what the move is from.
3. **One reverted package holds its lockfile group.** The pin step makes a lockfile group whole, so the group waits until the reverted package's target changes. What bounds it: each of the group's other moves says so in an issue of its own, and any can be made by hand.

## Consequences

- A fix of an image or a chart lists a day after its release is first seen. A run with no state starts that wait again for every image and chart.
- Where the move stays within the major and the next major clears more, the pin moves twice: the major is listed after the first move has merged.
- A chart whose move is its major is held at Guarded as any major is, so the finding it clears waits for the owner or for Lights-out.
- A scan that stops holds every move in both repositories within 36 hours, and nothing else.
- A routine update across a major waits for the owner at Guarded. Its pull request's description says so; it raises no alert and puts nothing in Needs you.
- The app needs its own `scan-state` environment and key. Each repository's environment is open to `main` alone, and the settings check reports one missing or open wider.
- The state's threat model, actor by actor, is in [Security scanning](../../COMPONENTS/SECURITY-SCANNING.md#the-states-threat-model).
