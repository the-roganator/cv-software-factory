# 0017: The GitHub worker queues this repository's local deploy pins once the gate passes them

## Decision

The factory's own deploy pull request for the local profile (`chore(deploy): run … on the local cluster`, labelled `deploy: local`, opened and moved by the deploy watch on `deploy/local`, ADR 0005) is added to the merge queue by the GitHub worker itself, as the App, with nobody's hand on it. It is added only when all of these hold, and once for each head (`github/deploy-queue.ts`):

- the App opened it, from this repository's `deploy/local` into `main`, not a draft, with the label and a title the deploy watch writes;
- the review App's own `review` check on that head passed it as `exact-pin` (ADR 0014): every changed line a digest under `deploy/`, each image signed by `build.yml` on `main`, from a commit ahead of the pin it replaces;
- every other check `main`'s rulesets require has a latest run on that head that finished and did not fail, by anyone but the factory's App;
- GitHub says it does not conflict with `main`, and it is not queued already.

It goes in at the head the gate judged (`expectedHeadOid`), through the same action and guards the line's enqueue uses. A failure that may pass is tried again on the next pass, a few times; a refusal is kept and signed as the worker keeps its others. In a dry run the watch reads GitHub as it is and records the enqueue it would make, changing nothing; a dry run's own deploy pull request, which GitHub never had, merges by the dry run's clock as before.

Nothing else is queued this way: not the app's deploy pull request, which stays the line's within Martin's autonomy level and auto-merge; not a pin move the gate passed (ADR 0019), which Martin adds; not a release, an improvement, a pull request of any other profile, or anything that is not the App's.

## Why

- **The merge Martin made was the change.** An image is built and signed from a commit of `main` that Martin, or the line within what he set, already merged. The local deploy pin only says that the local cluster should run it: once the gate has passed it as an exact pin and its checks are green, merging it decides nothing, and a hand on it only adds a wait before the cluster runs what `main` already holds.
- **The gate is the review.** `exact-pin` passes only digests of images `build.yml` signed on `main`, each moving forward; the gate reads the diff, GHCR and Sigstore itself, and the merge queue runs the required checks again on its own commit. The worker adds nothing the gate did not pass at that head, and GitHub merges nothing the queue's checks do not pass. The worker cannot widen what merges: it only saves the click.
- **The local profile alone.** The local cluster is Martin's development cluster, and disposable. A profile that serves visitors would deploy to them, and its pins stay a decision until an ADR says otherwise.
- **The worker, not the line.** The line acts on work items, and the factory's own deploys carry none: the line does not watch them (`line/deploy.ts`). The worker already opens and moves the pull request, knows the label and the branch, and holds the only key that can enqueue. A watch beside the deploy watch keeps the whole deploy in one place, and works while the line is stopped.
- **Not GitHub's auto-merge.** Auto-merge, turned on for a pull request, queues whichever head next meets the rules, and the worker would have to turn it on again for each build. Adding a judged head to the queue names the head, as the line's enqueue does.

## Consequences

- An image built on `main` reaches the local cluster without Martin: the deploy watch opens the pin, the gate passes it, the worker queues it, the queue merges it, and Argo CD syncs it.
- The worker's log says why a deploy pull request waits, once for each head and reason (`the deploy pull request waits to be queued`), and that it queued it (`added the deploy pull request to the merge queue`).
- The queue taking it out leaves that head for Martin, as the line leaves the app's. A worker that restarts may add the same head once more; the queue tests it again as before.
- A branch protection or permission change that stops the App enqueueing is kept, signed and logged as a `token-permission` refusal (`refusals.ts`), and the head waits for Martin.
- `AGENTS.md`'s rule on who merges names the worker beside Martin and the line.
