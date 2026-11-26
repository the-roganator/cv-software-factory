# 0024: The GitHub worker closes Dependabot's pull request once `main` has every change it makes

Martin decided it on 25 November 2026.

## Decision

Dependabot proposes moves the factory makes itself: the pin watch in this repository, the line in the app (ADR 0022, ADR 0023). The GitHub worker closes a pull request of Dependabot's, with one comment, when `main` already has every change it makes (`apps/factory/src/github/duplicates.ts`), in either repository. It closes one only when all of these hold:

- **Dependabot opened it,** by its numeric id, from a `dependabot/` branch of the repository itself, into that repository's `main`, and it is open.
- **`main`'s files have each change.** What it changes is read from GitHub, as the patch of each file: the lines each change adds are in `main`'s file as git has it, together and in the patch's order, and the lines it removes are nowhere in that file (`appliedIn`), so a pin moved at one place of a file and not at another like it is not taken for moved. A file whose patch GitHub does not send, a renamed file, or a count of files that is not the pull request's own cannot be read whole, and nothing is closed.
- **Nothing anyone wrote is read.** Not its title, its body or its branch's name, and no version is compared with another: the rule is whether a line is in a file.
- **Both heads are the ones judged.** The pull request's head and `main`'s are read again just before anything is written; a push to either is a conflict, and the next pass judges again.
- **The App has not closed it before.** The comment begins `` `main` already has every version this moves `` and names what brought the lines to `main`, by git's blame: the pull request that merged them, or the commit. One the App closed so and anyone opened again is left as it is, with no second comment.

Only the worker's own watch does it (`duplicateWatch`). The guard that holds the worker to the App's own issues and pull requests (`IssueGuard`, `github/issues.ts`) passes the close of Dependabot's pull request for the asker `duplicate-watch` and for no other, which no request over the worker's door can say it is, so no worker that asks, the line among them, can have one closed. A dry run's worker does not run the watch.

Guardrail 10 says so, as the second of its two stated exceptions (`policy/guardrails.ts`, spec section 6): the first is the enqueue of Dependabot's exact pin of the factory's workflows (ADR 0023).

## Why

- **An open pull request says a move waits.** Dependabot closes its own only when it notices `main` has the version, and sometimes it never does. One left open beside the App's merged move says something is still to be done that is not, and Martin closed each by hand.
- **Closing is right exactly while `main` has the versions.** Closing tells Dependabot not to propose those versions again, which is why nobody closes one that still moves anything. Once `main` has them all, that is what should happen.
- **What `main`'s files say, not what the pull request says of itself.** A title, a body and a branch's name are words, and a group's branch names no version at all. The patch held to `main`'s files needs no grammar of versions and no ecosystem's rules: a pull request that still moves anything, in any file, has a line `main` lacks, and stays.
- **Not left to Dependabot.** Its pull request then lingers until its next rebase, or for good, and the list of open pull requests stops saying what waits.
- **Not as soon as the scan lists the move.** A listed move is not a made one: the pin step may refuse it, its release may still be waiting, the gate or the autonomy level may hold it, its checks may fail. Closing then would tell Dependabot to skip a version nobody had moved to, and would need the pull request matched to a move by its branch's name, which a group's does not give.
- **The worker's watch, and no action of the door.** The factory acts on what it opened (guardrail 10), and an exception is kept as narrow as the enqueue's (ADR 0023): one act, on one author's pull requests, from one place in the code, which nothing can ask for. The worker holds the only key, reads GitHub already, and works while the line is stopped.
- **One comment, once.** Whoever looks at the pull request sees why it closed and which merge made it redundant. Opening it again is someone's word that it should be open, and the worker does not argue.

## Consequences

- Dependabot's pull request for a move the factory made closes within minutes of the merge, by whichever of Dependabot and the worker sees it first.
- One `main` has moved past is not closed by this rule: its lines are not in `main`'s files. It stays for Dependabot, which rebases or closes it, as does one that mixes versions `main` has with one it lacks.
- A pull request with a file whose patch GitHub does not send, as it does not for a very large change to a lockfile, is never closed by the worker.
- After the close Dependabot proposes none of those versions again. A `main` that later goes back to an older version is the scan's to see.
- A pull request that proves, when the close reads it, not to be Dependabot's own from its branch into `main` is refused, and the refusal kept and signed as the worker's others are.
- This decision amends ADR 0023, whose enqueue is one of two things the factory does to a pull request it did not open, and ADR 0022, whose pin watch leaves Dependabot's pull request for the same pin alone.
- `AGENTS.md`'s rules on merging and on Dependabot's pull requests name the close.
