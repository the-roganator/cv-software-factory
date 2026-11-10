# 0005: Images reach a cluster through pull requests that pin their digests

## Decision

Every image a cluster runs is pinned by digest, per profile, in the repository that builds it: the factory's images in this repository's overlays, the app's in its own. When CI builds a new image, the factory's GitHub App opens a pull request in that repository that moves the pin, and merging that pull request is the deployment: Argo CD deploys what each repository's `main` says. There is one open deploy pull request per repository and profile, always for the latest build of each image it moves.

## Why

Git stays the whole truth about what is running, and a deployment is reviewable, signed and revertible like any other change. The alternatives each break that. A mutable tag makes the cluster's state depend on when it last pulled. Argo CD Image Updater puts git write access in the cluster. Letting CI push to `main` gives a workflow a way round the ruleset. And a workflow that opens pull requests needs a token that can, which is also one that could approve them.

## Consequences

- A release to a cluster takes one more merge than a build. That merge is where autonomy applies: the app's is the line's within Martin's autonomy level, and this repository's local one the GitHub worker queues once the gate passes it as an exact pin (ADR 0017).
- A pin lives beside the build that made its image. The build workflow builds and pushes, tagged and labelled with its commit, and opens nothing. The factory's GitHub worker sees the new image in GHCR and, as the App, opens the pull request; it is the only thing that holds the App's key. No workflow may open or approve a pull request (`scripts/github-settings.ts`). Argo CD watches both repositories.
- The pin lives in a file of its own (a Kustomize component), so the deploy diff is one line.
- `main` accepts only signed commits, so the pin is committed through GitHub's API, which signs it.
- Each deploy pull request is labelled with its profile (`deploy: local`), so it is told apart from the release pull request and from Martin's own. `scripts/github-settings.ts` makes the label.
- The App's pull requests run their checks at once, without anyone approving the runs.
- Merging the deploy pull request must not build again, so the build watches only what goes into the image.
- A deploy pull request builds no image in its checks. Instead they confirm each digest it pins is in GHCR and labelled with a commit on `main`, and that each it moves to is signed by `build.yml` there, with its SBOM, so a digest from a branch's build, or a typo, cannot merge. They skip the browser tests, which nothing in a pin can change, and the tests, which read no digest (`scripts/deploy-files.test.ts`): the code is its base's, so the required `lint, types, tests` passes once the static half, which renders the manifests, has passed and the merge queue passed that check on the commit the deploy is made on. A pull request the App opened into `main`, whose every changed line is the digest of an image in the pin files, is treated so (`scripts/check-kind.sh`). Anyone's that changes only files under `deploy/` but the Postgres pin the browser tests run beside builds no image and skips the browser tests, since no image copies anything from there, and runs the tests; anything else runs every check.
- The merge queue tells a deploy the same way, on the change its entry makes on the commit it is made on, with the author and base of the pull request its branch names, read from GitHub's API; one it cannot read is not a deploy. Each entry, a queued stack's and a batch's too, is one pull request's change made on the entry ahead of it or on `main`, so a deploy's tests stand on that commit's run, and its own run passes only when that one did: each pass stands on a full run of the tests, back along its bases.
