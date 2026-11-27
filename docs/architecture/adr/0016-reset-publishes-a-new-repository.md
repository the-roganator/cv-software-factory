# 0016: A reset publishes the app again as a new repository, and a seed may pin a vulnerability nothing reaches

## Decision

### How a reset is done

A reset publishes a new repository, with no history, under the app's name, `the-roganator/cv-worlds-worst-website`. Before it does, the repository it replaces is renamed, made private and moved out of the organisation to the owner's personal account, beside the private repository.

The new repository's first commit is built in the private repository, as the first one was (ADR 0006), from:

- the correct app, with the owner's and Dependabot's changes to the public app brought into it (the private repository's `baseline-sync` skill);
- every defect patch, applied again;
- any new seeds, each a patch with its answer-key entry and its detector, like the rest. A vulnerable pin has no answer-key entry (see below).

The line's fixes are left out: they are what the reset undoes. So is any change of Dependabot's that moved a seeded pin, since it fixed a defect as the line's fixes do. The line's improvements are left out too, and are run again on the line after the reset, from the same requests.

So the seeded baseline moves with the owner's and Dependabot's changes, and the patches are applied again to it. The private repository's CI proves the set on the moved baseline: each patch alone trips its own detector, and the tree trips them all and gives nothing away.

Creating, renaming, moving and publishing repositories is the owner's, by hand.

### What a seed may be

A seed may pin a dependency of the app at a version with a known vulnerability that has a fix, when the vulnerability cannot be reached in production or in CI. CI counts because development dependencies run there beside the gates' tokens. Each such pin has a security review before it is seeded, which says why neither can reach it.

- **In the app only.** Nothing vulnerable is ever seeded in the factory.
- **Not secret.** Every other defect is found by noticing a symptom, so where it is must stay unknown. A vulnerability is found by a deterministic scan of what is pinned (ADR 0013), which anyone can run, so its place gives nothing away. It has no answer-key entry, and the scoreboard counts a dependency's ticket for nothing, found or false positive: the scan's own measure is on Patching's panel.
- **Never in a file the app's CODEOWNERS gives the owner,** like every other seed. Node and the base images are pinned only in such files, so neither is ever seeded.
- **A drill may bring one in again.** A drill is the owner's announced `chore(drill)` pull request, held to a seed's bar, Node or a base image among what it may pin. It passes the app's gates by an exception in `policy/vulnerabilities.ts` that expires the next day, so the finding comes back with its deadline the day after and nothing bypasses `main`'s ruleset (`make drill-vulnerability` prints what a drill needs). Whether the fix then merges without the owner is decided as for any move ([ADR 0027](0027-what-merges-without-the-owner.md)).

## Why

- **Not a pull request.** A reset's pull request would be a diff from the fixed app to the broken one: every seeded defect, named by the lines it changes, in public. That is the answer key.
- **Not a force-push.** The old repository's pull requests show the fix for every defect a reset brings back. GitHub keeps them, and the commits they name, public after the branch is rewritten. A force-push hides the history from `git log` and leaves the answers on the pull requests.
- **Private and out of the organisation.** The renamed repository still holds those fixes. Made private, it shows them to nobody; moved out of the organisation, no App installed across the organisation reaches it. What was copied while it was public, into a fork or an archive, stays where it was copied: a reset stops publishing the fixes, and cannot recall them.
- **The same name.** Argo CD's source, the factory's list of repositories and admission control's signer for the app (ADR 0010) all name the repository. Keeping the name keeps every one of them as it is, so a reset changes no rule of the line.
- **Applying the patches again, not restoring the first tree.** The owner's changes to the app's workflows, gates and dependencies are not defects. A reset that restored the first tree would undo them along with the line's. Bringing them into the correct app keeps one source of truth for what the app should be, and the patches stay small.
- **A real vulnerability.** Proving that a fixable Critical in what the app runs is scanned, triaged, fixed and merged needs a real one in the app: a fixture proves the rules, not that the line fixes what the scan finds. Keeping it unreachable in production and in CI keeps the app benign, as every seed must be.

## Consequences

- **Links to the old app's pull requests and issues stop working** for anyone but the owner. A link by number names the new repository's pull request of that number, if there is one. The milestone plans keep their references as written: "the app's #168" in a plan written before a reset means the old repository's.
- **The new repository is set up again:** both Apps installed, `scripts/github-settings.ts` applied, its variables set, and the GHCR package `cv-worlds-worst-website` linked to it. Until then its pull requests have no required checks and the line cannot work on it.
- **An image the old repository signed still verifies.** The signer is named by repository name, and the images and their signatures stay in the organisation's GHCR package, which a repository's move does not take with it. Once moved, anything the old repository signs names the owner's account, which no policy admits. Until the first deploy pin of the new repository, the cluster may run the old app's last image.
- **The first deploy after a reset waits for the owner.** An exact pin needs the new image's commit to descend from the old pin's (ADR 0014), and the new first commit descends from nothing in the old repository. A pin back to an old image is no exact pin either.
- **The local cluster is rebuilt with the new repository,** so the event store, the scoreboard's key and the app's history all start again together. A store that kept the old app's tickets would count them against the new key.
- **A seeded Critical's deadline starts at the first scan,** two days later (ADR 0013), since no finding counts from before the day it is first seen. A reset is timed for when the line can take it.
- **Dependabot sees a seeded dependency** as it sees any other. Its pull request for one is left open until the line's fix merges, then closed by Dependabot or by the GitHub worker ([ADR 0027](0027-what-merges-without-the-owner.md)).
- **The injector** applies one of the same patches to the app as it then stands, as an ordinary pull request.
