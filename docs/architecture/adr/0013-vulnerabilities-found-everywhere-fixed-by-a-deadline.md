# 0013: Everything the factory builds or runs is scanned every day, and each finding is fixed by a deadline

## Decision

A known vulnerability is looked for in everything the factory and the app build or run, not only in what a pull request changes. It is looked for every day, against that day's advisories, and each finding has a deadline by its severity.

### What is scanned

The list of what is scanned is worked out from each repository, never kept by hand:

- **Each repository's lockfile,** development dependencies included, since they run in CI beside its tokens and on Martin's Mac.
- **Each image of ours that `main` pins,** from the SBOMs `build.yml` attests, so nothing large is pulled.
- **Each third-party image the manifests pin by digest:** Postgres, its exporter, the proxy's nginx, and flagd once it is deployed, from CI's copy in GHCR where `mirror.yml` keeps one, since Docker Hub limits anonymous pulls by address.
- **The platform:**
  - each image the platform's charts run at the versions `deploy/` pins, rendered with our values: Argo CD, Argo Rollouts, Kyverno, Prometheus and Alertmanager, Grafana, Loki, Tempo and the collector;
  - the k3s node image `deploy/k3d/cluster.yaml` pins, and the images that k3s release starts (Traefik and CoreDNS among them), from the release's own list of images, and the load balancer and tools images k3d starts beside it, at the version `mise.toml` pins.
- **What CI runs beside its tokens:** each Dockerfile's build stages, and the images the workflows start (`scripts/ci-images.sh`'s, Playwright's among them).
- **The Node binary** in each image, not only its packages. Task 28 proves the scan of an SBOM finds it; where an SBOM does not carry it, the image itself is scanned.

Each source gives its own part of the list: the rendered manifests, the k3s release's list, k3d's version in `mise.toml`, the Dockerfiles and the workflows. Tests hold each part to its source. The list cannot see what it was not built from, so the check that is not circular is Part D's sense, which compares every image the cluster is running with the list. An item the scan cannot read is a finding in itself, reported apart from vulnerabilities, so nothing is left out quietly and a failed pull is not mistaken for one. The workflows' actions stay with Dependabot, which already sees them.

### How it is scanned

- **One scanner, Trivy, pinned by digest,** as the app's image gate already pins it, so the gates, the daily scan and Part D's routing check agree on what a finding is and how severe it is. The pin is kept in a file of this repository's that Dependabot's `docker` updates read, since it reads no workflow's `env`, so a new release of Trivy reaches a pull request as other images' do; it is always read from this repository at the commit the workflow runs from, never from a change or the app, so no pull request chooses its scanner; and a bump is held to Aqua's signature, its signer named whole. Trivy reads no Node runtime, so the scan matches each image's Node version against Node's own core vulnerability database (nodejs/security-wg), whose entries carry the publisher's rating: the one finding that is not Trivy's.
- **It reads the lockfiles itself.** GitHub's dependency graph does not read these pnpm lockfiles: it lists each `package.json`'s ranges and none of the packages they resolve to, so Dependabot's alerts and dependency review see direct dependencies alone. A test compares the packages the scanner reads with the ones `pnpm list` gives, and fails when they differ.
- **A scan fails closed.** One that cannot read a lockfile or an SBOM, reach an image, or fetch the day's advisories fails, and is never read as clean. It pulls with the workflow's token, Trivy's advisory database included, and retries before it gives up.

### When it is scanned

- **On every pull request, in both repositories:** the base's lockfile against the change's, failing on any known vulnerability the change brings in, as dependency review does on the app's pull requests. It is required in both repositories' rulesets. It runs as the app's gates do: on `pull_request`, with a read-only token, executing nothing from the change. The app's image gate stays as it is.
- **Every day, and on each push to `main`:** everything on the list, against that day's advisories. The results go to code scanning in the repository that owns each item, one alert for each package and advisory, located in its lockfile or naming its image. The app calls the workflow from this repository at a pinned commit, as it calls Scorecard, so it scans its own lockfile and images.

### The dependency graph

On each push to `main`, a job submits Syft's SBOM of the lockfile to GitHub's dependency submission API, so Dependabot's alerts and dependency review see every package. Dependabot opens no security update for a dependency submitted this way, so the graph brings alerts, not fixes. That job alone holds `contents: write`, runs only on a push to `main`, checks out without keeping its token, and executes nothing from the repository: Syft, pinned by digest, reads the lockfile, and nothing installs it or runs a script from it. The pull request gate does not depend on it.

### Deadlines

A finding's severity is the higher of the scanner's rating and that of the project that published the fix, as milestone 7's Patching decisions set. The publisher's rating counts wherever a machine can read one; where it cannot, the scanner's stands alone. Its deadline counts from the day its fix can be installed: the first fixed version's publish time in its registry, plus pnpm's day for a package, or the patched image's release. No first finding counts from before the day it is first scanned. Both are worked out from the registry and the code-scanning alert on each run, so the scan keeps no state of its own:

| Severity | Fixed within |
|---|---|
| Critical | 2 days |
| High | 7 days |
| Medium | 30 days |
| Low | 90 days |

A finding with no fix has no deadline. It stays open, and is looked at again when a fix appears. The daily scan reports each open finding's age against its deadline.

### Exceptions

A finding that cannot reach us (a package installed but never loaded, a path never called) is excepted in `policy/vulnerabilities.ts`. Each entry gives the repository, the advisory, the package, why it cannot reach us, and an expiry no more than 90 days away. When an entry expires, its finding returns.

The file is code-owned, and the scan reads it from this repository's `main`, not from the commit the app pins, so moving the pin back cannot bring back an exception that has gone. It checks each entry's expiry against the day it runs. It never reads an ignore file from the repository it scans, since agents write to the app's repository. Scorecard reads `osv-scanner.toml` beside each lockfile, so each is generated from the policy and code-owned in its repository. The daily scan reports one that differs; no pull request fails for it, so an exception merged here never blocks the app.

### Who fixes it

- **The app:** the line, as milestone 7's Patching (Part D) sets out.
- **The factory's lockfile, its images and the platform:** Martin, from an issue the scan's finding opens (Part D), which `/implement` can take as it stands. Dependabot's security updates cover direct dependencies; an indirect one is a lockfile refresh, or an override when its parent's range does not admit the fix.

The daily scan fails on a new High or Critical finding, on one due within a day, and on any deadline passed. Its log, which anyone can read in a public repository, gives counts by severity and deadline; the packages and advisories are in code scanning, which only those with access to the repository's security findings see. A failed scheduled run is GitHub's own notice to Martin, who alone changes the workflows, with no new secret in CI. From Part D, the factory reads each day's results with its App and alerts him at Notify, through Alertmanager.

## Why

- **Most vulnerabilities arrive in code nobody changed.** A gate on pull requests sees only what a change brings in. An advisory published tomorrow against a package locked today is found only by scanning again. Each image's SBOM is already attested, so scanning again every day costs a download of the day's advisories.
- **CI, not the cluster.** The local cluster is not always running, and its egress is fenced to what each part needs. A scanner inside it would need the advisory database's hosts, and would see nothing while the cluster is down. A finding is about what `main` pins. Part D's sense compares the running digests with what was scanned, so drift is caught there.
- **Trivy, not a second scanner.** The app's image gate already pins it, and Part D's routing check decides on its rating alone. Two scanners would disagree about severity and coverage, and a Critical fix could merge on one and fail on the other.
- **Not GitHub's dependency graph alone.** It reads manifests here, not the lockfiles, and dependency review's comparison is only as complete as the graph. Submitting the graph brings back Dependabot's alerts on every package, and dependency review's view of them, though not its security updates for indirect ones. The gate stays on our own scanner, so it never waits on a snapshot or a token that can write.
- **Scorecard is an outside score, not the detector.** It runs weekly and on each push, and reports all its findings as one alert with no file, which notifies no one. It stays, as spec 8 asks: generating its ignore file from the same policy keeps its score honest about what is excepted.
- **Deadlines make time to patch something that can be measured.** Without them, a finding has no owner and no date. The figures follow common practice for internet-facing software, scaled to one maintainer: Critical within two days of its fix being installable.
- **Exceptions live where agents cannot write.** An ignore file in the app's repository would let a change there hide a vulnerability from the gate that judges it.

## Consequences

- Scanning everything finds what is already there. The first full scan opens alerts on the platform's images and on development dependencies, each with its deadline from that day.
- Each repository's code scanning shows one alert for each package and advisory, so a finding has a file or an image, and can be dismissed, with a reason, by an exception.
- A day when Trivy's advisory database cannot be fetched is a failed run, not a clean one.
- The factory's App needs to read code scanning alerts in both repositories from Part D, a change to its permissions in `scripts/github-settings.ts`. It is read-only, and covers CodeQL's alerts too, so their text reaches the sense as untrusted input, as every signal's does: a fix is read from the scans, never from an advisory's words.
- Charts pin images by tag, not digest, so a platform image is scanned as the tag resolves that day. Pinning the platform's images by digest is not part of this decision.
- Scorecard's Vulnerabilities score rises only as findings are fixed or excepted.
