# 0017: The GitHub worker queues this repository's local deploy pins and pin moves once the gate passes them

## Decision

The factory's own deploy pull request for the local profile (`chore(deploy): run … on the local cluster`, labelled `deploy: local`, opened and moved by the deploy watch on `deploy/local`, ADR 0005) is added to the merge queue by the GitHub worker itself, as the App, with nobody's hand on it. It is added only when all of these hold, and once for each head (`github/deploy-queue.ts`):

- the App opened it, from this repository's `deploy/local` into `main`, not a draft, with the label and a title the deploy watch writes;
- the review App's own `review` check on that head passed it as `exact-pin` (ADR 0014): every changed line a digest under `deploy/`, each image signed by `build.yml` on `main`, from a commit ahead of the pin it replaces;
- every other check `main`'s rulesets require has a latest run on that head that finished and did not fail, by anyone but the factory's App;
- GitHub says it does not conflict with `main`, and it is not queued already.

The pin watch's pull request for a move of the scan's (ADR 0013), which the gate passed as `pin-move` (ADR 0019), is added on the same terms, each open one on its own, when all of these hold:

- the App opened it, from this repository's `factory/pin/<move>` (one segment, the pin watch's branch) into `main`, not a draft, labelled `pin`, and the App alone ever gave it that label or took it off, by its events, so Martin holds one by taking the label off, though the pin watch puts it back;
- the review App's own `review` check on that head passed it as `pin-move`: no other rule, so not a hold, and not Martin's approval of a held one (`martin-approved-head`), which leaves adding it his;
- every other required check, and the conflict and the queue, as for the deploy pin.

It goes in at the head the gate judged (`expectedHeadOid`), through the same action and guards the line's enqueue uses. A failure that may pass is tried again on the next pass, a few times; a refusal is kept and signed as the worker keeps its others. In a dry run the watch reads GitHub as it is and records the enqueue it would make, changing nothing; a dry run's own deploy pull request, which GitHub never had, merges by the dry run's clock as before.

Nothing else is queued this way: not the app's deploy pull request, which stays the line's within Martin's autonomy level and auto-merge; not a pull request the gate held, even once Martin approved its head; not a release, an improvement, a pull request of any other profile, or anything that is not the App's.

## Why

- **The merge Martin made was the change.** An image is built and signed from a commit of `main` that Martin, or the line within what he set, already merged. The local deploy pin only says that the local cluster should run it: once the gate has passed it as an exact pin and its checks are green, merging it decides nothing, and a hand on it only adds a wait before the cluster runs what `main` already holds.
- **The gate is the review.** `exact-pin` passes only digests of images `build.yml` signed on `main`, each moving forward; the gate reads the diff, GHCR and Sigstore itself, and the merge queue runs the required checks again on its own commit. The worker adds nothing the gate did not pass at that head, and GitHub merges nothing the queue's checks do not pass. The worker cannot widen what merges: it only saves the click.
- **A pin move is proved, not trusted.** The gate passes `pin-move` only on what it reads itself: the pins alone changed, forward on their line, scanned on both platforms, and run by a check (ADR 0019). The worker's terms read the branch, the label and who gave it, not because the gate needs them but so that nothing but the pin watch's own pull request is queued on the rule: the gate trusts no branch name, so a commit of valid pin-move content on another `factory/` branch would pass it, and is still not queued. A pull request the gate held is a decision, and Martin's approval of it makes it his, not the worker's, to add.
- **The local profile alone.** The local cluster is Martin's development cluster, and disposable. A profile that serves visitors would deploy to them, and its pins stay a decision until an ADR says otherwise.
- **The worker, not the line.** The line acts on work items, and the factory's own deploys carry none: the line does not watch them (`line/deploy.ts`). The worker already opens and moves the pull request, knows the label and the branch, and holds the only key that can enqueue. A watch beside the deploy watch keeps the whole deploy in one place, and works while the line is stopped.
- **Not GitHub's auto-merge.** Auto-merge, turned on for a pull request, queues whichever head next meets the rules, and the worker would have to turn it on again for each build. Adding a judged head to the queue names the head, as the line's enqueue does.

## Consequences

- An image built on `main` reaches the local cluster without Martin: the deploy watch opens the pin, the gate passes it, the worker queues it, the queue merges it, and Argo CD syncs it.
- A pin move the scan found reaches `main` without Martin: the pin watch opens it, the gate proves it, the worker queues it, the queue merges it. One the gate holds waits for him, with its reason.
- The worker's log says why a deploy or pin pull request waits, once for each head and reason (`the deploy pull request waits to be queued`, `the pin pull request waits to be queued`), and that it queued it (`added the deploy pull request to the merge queue`, `added the pin pull request to the merge queue`).
- The queue taking it out leaves that head for Martin, as the line leaves the app's. A worker that restarts may add the same head once more; the queue tests it again as before.
- A branch protection or permission change that stops the App enqueueing is kept, signed and logged as a `token-permission` refusal (`refusals.ts`), and the head waits for Martin.
- `AGENTS.md`'s rule on who merges names the worker beside Martin and the line.
