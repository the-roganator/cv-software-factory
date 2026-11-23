# 0022: The review gate passes a change that is exactly the scan's moves, and the autonomy level decides which merge

## Decision

A move of the daily scan's (ADR 0013) merges with nobody's hand on it when three questions each have a yes:

1. **Is the change exactly what the scan asked for, and nothing else?** The review gate answers it.
2. **Did every required check pass?** Whoever adds it to the merge queue waits for them on the head, and the queue runs them again on its own commit.
3. **Does the level allow it?** Martin's autonomy level and auto-merge switch, which the line and the GitHub worker read from the store.

### The gate's one rule

The gate passes, as `move`, a pull request into `main` from a branch of the repository, in either repository and whoever opened it, that is exactly moves the scan of `main` asked for; and names it `major` when one of them crosses a major and clears no Critical by Trivy's own rating, never the publisher's (`scripts/move.ts`). The rule comes after `exact-pin` and before `low-risk` (ADR 0014).

- **The moves are the scan's.** The gate reads them from the newest finished run of `vulnerabilities.yml` on `main`, by schedule, push or hand: its `moves.json`, joined with the state that run sealed (ADR 0021), so a lockfile's move has its package and versions. Where a move's pins are, what it moves to, whether it crosses a major and what it clears are facts the scan decided once. The gate reads none of them from the pull request.
- **The gate makes them itself,** on `main`'s tip (for the merge queue's commit, on the commit it was made on), as the one who makes each move makes it: a pin's line by the pin watch's own edit; a lockfile's package, an image that brings another pin with it (the Node it runs, or Playwright's library), and in this repository a tool mise pins, by the pin step (`apps/runner/src/pins.ts`), run on a checkout of `main` with this repository's pnpm and mise, no script, no pnpmfile and no secret (`scripts/derive.ts`). It makes them as the scan made them, in either repository: as of the scan's time, and with the digests the scan's pin step was given, which the scan sealed (its job `pins`) and which the app's line's pin step is given too. A release or a tag pushed since changes nothing it makes, and nothing a pull request carries says how it was made.
- **Then it compares** what it made with what the merge makes, every file, byte for byte. A pull request may carry several of the day's moves, and must carry each whole. Anything that differs is refused, and the reason says where: a line no move writes, a pin left unmoved, a version or digest other than the scan's, a file added, removed or changed in mode, a file that is not UTF-8, anything under `.github/`. A reason never names what a lockfile's move withholds. An image of ours passes only as an exact pin.
- **It reads no level.** It names what it found; the level decides who queues it. The app's `AUTONOMY` variable is read by no move.

`review.yml` works the answer out in a job of its own, `move` (`scripts/moves.ts`), from `main`'s checkout, with read-only permissions and one secret: the scan-state key, from the environment `scan-state`, which only `main` may use, read once and taken out of the environment before anything runs. It fetches the pull request's two commits as data and runs none of them, and hands the gate one answer for each pull request at its head. The gate, which holds the review App's key, reads no head itself; a head the job did not judge, as after a push while it ran, is a pending hold until the run that push started judges it.

### The one level

One table, `ENQUEUES` in `policy/line.ts`, says which of the gate's rules each level queues, and the line and the GitHub worker both ask it, each only with auto-merge on:

| | Supervised | Guarded | Lights-out |
|---|---|---|---|
| `move` | waits | queued | queued |
| `major` | waits | waits | queued |

The worker reads Martin's controls from the store before each enqueue, as `factory_github`, a role that may read those events and nothing else. Controls it cannot read are Supervised with auto-merge off. The level governs new change: the line's fixes, and every move in both repositories. It does not govern the factory's local deploy pin, which runs only what Martin already merged, and which the worker queues at every level (ADR 0017).

The level is the worker's alone. The gate does not refuse a `major` below Lights-out: it names it, and the worker's reading of the level keeps it from the queue, so the factory's App's key alone could add an exact major to the merge queue at Guarded. That is accepted: the gate still proves the change is exactly the scan's move, and what stands behind every merge stands behind that one.

### Who makes each move

The factory's App makes every move the scan lists. A move's lane (`apps/factory/src/vulnerabilities/moves.ts`) says who: `line`, every move of the app's; `worker`, every move of the factory's a pull request of the App's can write; `cluster`, k3s, whose pull request merges as any other's and which `make upgrade-cluster` then applies; `issue`, what the App may not write (a workflow's pin, the Makefile's); `none`, a line no longer built. No lane waits for Dependabot or for Martin's approval.

In this repository the pin watch keeps one pull request for the day's moves at a set of files, on a branch named for them, and a `major` rides apart on its own so the rest do not wait for it. A move no pin's line writes (a lockfile's package, a tool mise pins, an image that brings another pin with it) is made in the scan's own run, by its job `pins` (`scripts/pins.ts`), where pnpm and mise run beside no key of the App's; it seals what it made as the artifact `pins`, and the watch commits those files whole through its guard. A move the pin step refuses (pnpm's guards, mise's release age) waits, with an issue. So the App's pull request may write `mise.toml` and `mise.lock`; any other change to the toolchain is still `mise upgrade`.

In the app the line makes each move with the pin step on `main`'s tip and commits it itself. The app's scan runs the same `pins` job, which commits nothing there: what the line takes from it is the time the scan judged its moves and the digest it was given for each tag, which the line reads through the GitHub worker and gives the pin step, so the line makes the move as the gate will.

## Why

- **Not patching is the danger.** The scan gives a Critical two days and a High seven (ADR 0013). A move it proved was needed still waited for Martin's approval, which added nothing: he would approve every move the scan finds, and he cannot judge a digest or a lockfile by eye. Each day a move waits, the factory runs what it knows to be vulnerable.
- **Exactly the scan's move is a question the gate can answer.** The scan decides a move once: its pins, its target forward on its line, whether it crosses a major, what it clears. The gate need not judge that again, only that the pull request is that move and nothing else, which it knows by making the move and comparing bytes. A pull request shaped to look like a move is not those bytes.
- **What the checks prove is theirs to prove.** Whether a move breaks something is what the required checks test, and the merge queue on its own commit. Whether it brings a new finding is the next daily scan's to find, and that scan moves it too. A gate that scanned, rendered and read check runs again made a weaker second copy of each, and held moves that were right.
- **One table, so a level means one thing.** A second setting for moves, such as the app's `AUTONOMY`, would leave two places Martin must keep alike.
- **The App makes every move, so none waits on another party.** Dependabot's security updates move direct dependencies alone, read no mise, and keep their own schedule.
- **One pull request for a file's moves.** Moves at one file apart would conflict, and each would cost a round of checks and a queue run.
- **pnpm and mise run where the App's key is not.** Making a lockfile's move runs pnpm's resolver on what the registry serves; in the scan's `pins` job it runs beside no key of the App's, and the worker, which holds one, only commits the files.

## Consequences

- This decision supersedes ADRs 0019 and 0020: `pin-move` and `critical-fix`, their scripts and their conditions are gone. An event that named either reads as `move`.
- It amends ADR 0017, whose worker queues a pin pull request the gate passed as `move` or `major` when the level and auto-merge allow that rule, and ADR 0021, whose key the scan's `pins` job and the gate's `move` job hold too.
- **What this does not catch: a real upstream release that is itself bad.** A chart that widens permissions, an image whose publisher was compromised, a package that fixes the finding and ships something else. Martin's approval did not catch it either. What stands against it: the required checks, on the head and in the merge queue; pnpm's guards and mise's release age; admission (ADR 0010); and in the app the canary's analysis and rollback.
- A move in the app passes with its tags (`dependency-change`, and `code-owned` on its pins' own files) whatever `AUTONOMY` says.
- The gate passes a move from a branch here whoever opened it, Dependabot's among them; only Martin, the line, and the worker for the App's own pull requests add one to the queue, so Dependabot's waits for him. The pin watch leaves Dependabot's pull request for the same pin alone, and Dependabot closes it once `main` has moved.
- The gate judges a pull request against the newest scan of `main`: one made from an earlier day's moves is refused once they change, until the pin watch moves its branch to the day's. In the app, whose line's branch nothing moves, a pull request made before a newer scan whose time or answers make the move otherwise waits for Martin.
- A major the level holds shows only in its pull request's description, which says what to do: no card in the console, and no alert.
- Every verdict waits for the `move` job, which a caller of `review.yml` gives the key by name, as it gives the review App's.
- `GH_TOKEN="$(gh auth token)" AUTONOMY= SCAN_STATE_KEY=<the repository's key> mise exec -- node scripts/moves.ts --print --as-app <owner/name> <number>` says what the gate would of a pull request, its move worked out on the Mac, and posts nothing.
