# 0016: A reset publishes the app again as a new repository, and a seed may pin a vulnerability nothing reaches

## Decision

### How a reset is done

A reset publishes a new repository, with no history, under the app's name, `the-roganator/cv-worlds-worst-website`. Before it does, the repository it replaces is renamed, made private and moved to Martin's account, `mrogan`, beside the private repository.

The new repository's first commit is built in the private repository, as the first one was (ADR 0006), from:

- the correct app, with Martin's and Dependabot's changes to the public app brought into it (the private repository's `baseline-sync` skill);
- every defect patch, applied again;
- any new seeds, each a patch with its answer-key entry and its detector, like the rest.

The line's fixes are left out: they are what the reset undoes. So is any change of Dependabot's that moved a seeded pin: it fixed a defect, as the line's do. Its improvements are left out too, and are run again on the line after the reset, from the same requests.

So the seeded baseline moves with Martin's and Dependabot's changes, and the patches are applied again to it. The private repository's CI proves the set on the moved baseline as it did on the first: each patch alone trips its own detector, and the tree trips them all and gives nothing away.

Creating, renaming, moving and publishing repositories is Martin's, by hand.

### What a seed may be

A seed may pin a dependency of the app at a version with a known vulnerability that has a fix, when the vulnerability cannot be reached in production or in CI. CI counts because development dependencies run there beside the gates' tokens. Each such pin has a security review before it is seeded, which says why neither can reach it; a vulnerability that only CI could not reach, or only production, is not seeded.

- **In the app only.** Nothing vulnerable is ever seeded in the factory.
- **Not secret.** Every other defect is found by noticing a symptom, so where it is must stay unknown. A vulnerability is found by a deterministic scan of what is pinned (ADR 0013), which anyone can run, so its place in the tree gives nothing away. Part D's repeat runs therefore bring a vulnerable pin in again with an announced `chore(drill)` pull request, as the canary's drills were Martin's own commits. The cases that try to fool the routing check (a fix the scans do not show, a finding gone because its package went) stay as fixtures in its tests, not seeds.
- **Never in a file the app's CODEOWNERS gives Martin,** like every other seed. Node is pinned only in `mise.toml` and `mise.lock`, and the base images, the build stage's Node among them, only in `Dockerfile`, all his, so neither Node nor a base image is ever seeded. An old one comes only as a drill, in Martin's announced `chore(drill)` pull request, held to a seed's bar: a vulnerability nothing can reach in production or in CI, where the toolchain's Node runs beside the gates' tokens, with its security review first. Its fix touches those files too, so it merges only with his approval.

## Why

- **Not a pull request.** A reset's pull request would be a diff from the fixed app to the broken one: every seeded defect, named by the lines it changes, in public. That is the answer key.
- **Not a force-push.** The old repository's pull requests show the fix for every defect a reset brings back, and GitHub keeps them, and the commits they name, public after the branch they merged into is rewritten. A force-push hides the history from `git log` and leaves the answers on the pull requests.
- **Private and out of the organisation.** The renamed repository still holds those fixes. Made private, it no longer shows them; moved to Martin's account, no App installed across the organisation reaches it, which is why the private repository is there (spec section 9). What was copied while it was public, into a fork or an archive, stays where it was copied: a reset stops publishing the fixes, and cannot recall them.
- **The same name.** Argo CD's source, the factory's `REPOSITORIES` and admission control's signer for the app (`build.yml` on `main` of `the-roganator/cv-worlds-worst-website`, ADR 0010) all name the repository. Keeping the name keeps every one of them as it is, so a reset changes no rule of the line.
- **Applying the patches again, not restoring the first tree.** The first tree is out of date once Martin has changed the app: his changes to its workflows, gates and dependencies are not defects, and a reset that undid them would undo his work along with the line's. Bringing them into the correct app keeps one source of truth for what the app should be, and the patches stay small.
- **Vulnerabilities now.** Part D proves that a fixable Critical vulnerability in what the app runs is scanned, sensed, triaged, fixed and merged without Martin. That needs a real one in the app: a fixture proves the routing check's rules, not that the line finds and fixes what the scan finds. Keeping it unreachable in production and in CI keeps the app benign, as every seed must be.

## Consequences

- **Links to the old app's pull requests and issues stop working** for anyone but Martin, in this repository's docs and anywhere else. A link by number names the new repository's pull request of that number, if there is one, not the old one. The milestone plans keep their references as the record of their time: "the app's #168" in a plan written before a reset means the old repository's.
- **The new repository is set up again:** the factory's App and the review App installed on it, `scripts/github-settings.ts` applied, its variables set (`AUTONOMY` among them), and the GHCR package `cv-worlds-worst-website` linked to it, so its `build.yml` may publish there. Until then its pull requests have no required checks and the line cannot work on it.
- **An image the old repository signed still verifies.** The signer is named by repository name, and the name is the same. Each signature records the identity it was made with, and the images and their signatures stay in the organisation's GHCR package, `ghcr.io/the-roganator/cv-worlds-worst-website`, which a repository's move does not take with it, so the policy needs no second identity for the change-over. Those images were built by `build.yml` from the old repository's `main`, reviewed as every merge was, and the old repository is Martin's and private now, so none is built there under that name again: once moved, anything it signs names `mrogan`, which no policy admits. Until the deploy pull request pins the new repository's first image, the cluster may run the old app's last one, which is acceptable for the same reason. A pin back to an old image is no exact pin, since its commit does not descend from the new repository's, so it waits for Martin.
- **The first deploy after a reset waits for Martin.** The review gate passes the factory's App's deploy pull request as an exact pin only when the new image's commit descends from the one the replaced pin was built from (ADR 0014). The new repository's first commit descends from nothing in the old one, so that pull request is held for him, once.
- **The local cluster is rebuilt with the new repository,** so the event store, the scoreboard's key (the new answer key, from `make up`) and the app's history all start again together. A store that kept the old app's tickets would count them against the new key.
- **A seeded Critical starts its deadline at the first scan,** two days (ADR 0013), since no finding counts from before the day it is first seen. A reset is timed for when the line can take it, and the daily scan fails if the line has not fixed it by then, as it would for any Critical.
- **Dependabot sees a seeded dependency** of the app as it sees any other, and its pull request for one is taken up by the line rather than opened again (Part D). Node in `mise.toml`, which a drill may pin, it does not read.
- **A drill's pull request brings a known vulnerability in,** which the lockfile gate, or for a base image the image scan, exists to refuse, and nothing bypasses `main`'s ruleset (ADR 0014). How a drill passes it, without a bypass and without hiding the finding from the daily scan, is settled in Part D before its first repeat run.
- **The injector** (milestone 8) is unchanged: it applies one of the same patches to the app as it then stands, as an ordinary pull request.
