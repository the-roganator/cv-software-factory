# Patching

How the factory keeps what both repositories run and pin patched: the scan's moves, and the dependency sense that reads them each day. Part of the [factory plane](README.md#factory-plane); [the patching diagram](../architecture/patching.html) follows one from advisory to cluster. A **move** is one thing (a package, an image, Node, a chart, k3s) going from what is pinned to a target, in one repository, with every pin that names it: the unit of work, as a finding, one package and one advisory in one item, is the unit of evidence ([terms](../TERMS.md)).

## The moves

The daily [vulnerability scan](SECURITY-SCANNING.md) groups each day's findings with a fix into moves, a pure function of its results (`apps/factory/src/vulnerabilities/moves.ts`), each with its pins, from and to, what it clears and leaves by severity, its earliest deadline, how many of its findings are new today, and its lane, which says who moves it. It uploads them as `moves.json`, with every image it read (`scanned`), and each result's message names what fixes it and its move. The factory reads them only through the [GitHub worker's `moves` read](GITHUB-WORKER.md#for-patching), which checks the artifact against the alerts.

## The dependency sense

`factory patching` (`apps/factory/src/patching`), a worker of its own in `factory`, connecting to the store as its own role, `factory_patching`. As it starts, and each day at 05:30 UTC once the scan (04:17) has finished (`PATCHING_AT`), it:

- asks the GitHub worker, through [its door](GITHUB-WORKER.md#the-senses-door), for both repositories' moves and open Dependabot pull requests;
- lists the images every pod runs (its init and ephemeral containers too: an image `kubectl debug` runs is one the cluster runs), by the reference its spec names and the digest its runtime resolved, in every namespace but three ([below](#the-namespaces-it-reads); in `PATCHING_NAMESPACES`, an empty item or a name that is not a namespace's stops the sense as it starts, since it would list every one), since an image the list lacks may run in any;
- compares the two, and appends the day as one event, `patching.read`, when it differs from the last it appended.

A read that fails, of either repository or of the cluster, appends nothing and says which failed in its log, as an error; it tries again an hour later, until the day's read comes round. A moves read the GitHub worker asks for again (409 with the kind `read-again`: a scan finished while its alerts were read) is no failure: it appends nothing, says so as information, and reads again ten minutes later; the sixth in a row, some fifty minutes after the first, is a failure, and any other pass starts the count again. Any other read asked for again is a failure, and so is any `conflict`, GitHub's own 409, the moves read's too. A pass whose failed reads were all refused at the worker's door, or that the store refused (`ECONNREFUSED`: the worker is starting, as when a deploy restarts it beside the sense, which reads first, or the network policy has not yet admitted a new pod, which has taken up to 2.5 minutes on a new cluster), appends nothing, says so as information, and is taken again fifteen seconds later; the 21st in a row, some five minutes after the first, is a failure, and a refusal of the cluster's read is a failure at once. `--once` exits 0 for a day read, 1 for a read that failed, and 75 for one to take again or refused; the counts are the running sense's, so a `--once` asked for again exits 75 each time. A day that says what the last said appends nothing: a pod made again under a new name, or a Deployment scaled, is no new day while its row stands. It acts on no store of samples.

### The day

`patching.read` (`packages/events/src/schemas.ts`) holds, for each repository, the scan's run it was read from (its id, how it was started, its conclusion, commit and link), when the scan judged its moves, why it failed as its own totals count it (a finding past its deadline, one due within a day, a new High or Critical with a fix, or `other`), its totals as `moves.json` gives them, copied and never worked out here (results with a fix, the moves and the moves in each lane, and the findings with no fix, excepted, past their deadline, due within a day, and new today at High or Critical with a fix and without), how many images it read, and its moves as `moves.json` gives them, with two additions: a lockfile's move's package, versions and pins, which the alerts give and the artifact withholds (`package`), and the open Dependabot pull request moving a move's pin, matched by the dependency and directory its branch names (`pullRequest`). The public view leaves a lockfile's move's package out until such a pull request is open, which names it anyway; everything else is as the scan's log has it.

Only the sense's role appends it, by a restrictive policy every role's insert must meet, and Martin's command line only as samples (`0050_patching.sql`): the Patching panel, Needs you and the alerts to Martin's phone read what waits and what is due from it, so no worker that untrusted input had turned can write a day in which nothing waits.

### What the cluster runs that the list does not say

Each is a row of the day, with no target, since each means the list or the cluster is wrong (`apps/factory/src/patching/compare.ts`, a pure function of the pods and the lists):

- **`unscanned-digest`**: a container runs a reference the list has, at a digest the scan never read: a tag rebuilt upstream since the scan, or since the pod pulled it. A pod's digest may be its index's or a platform's manifest's: the list gives every one the scan saw of each image.
- **`unlisted-image`**: a container runs an image no item of either repository names, or one whose repository the list names at other references only.
- **`not-running`**: a pin `main` holds that the cluster does not run yet, while it runs another reference of the same image instead: Argo CD after a merge, a k3s move not yet applied. The pin of an image no pod runs at all is no row, since an image may run only now and then (a runner's, a Job's); nor is one of a kind no pod runs (a workflow's, a build stage's, k3d's).

A reference is compared by its repository, normalised as Docker does (`postgres` is `docker.io/library/postgres`), then by its digest when the pod names one, or else by its tag. With a repository's list missing, as when its scan failed before it wrote one, the cluster is not compared (`compared: false`), since every image of it would look unlisted.

### The namespaces it reads

Every namespace the cluster has, `default` included, but three, which `PATCHING_NAMESPACES` lists and the RoleBindings bind; a test holds the two together, and fails for a namespace `deploy/` renders, or one of the cluster's own it names (`default`, `kube-system`, `kube-public`, `kube-node-lease`, `argocd`, `kyverno`), until it is in one or named as left out. A namespace made at run time (by a chart, a try, or a k3s of another version) is in neither, and is not read until someone adds it.

- **`runners`**: an agent step's Job carries its job token in its spec, as a value (a pin step's and a lockfile's carry none), so whatever lists pods there can read live tokens; only the line may.
- **`red-team`**: only the red-team harness's two attack pods run there, each held by an admission rule to one of two images and a pinned command, the unsigned one refused as it is created.
- **`scoreboard`**: the answer key's namespace, where no role of ours is bound but the line's list of its Events, so that nothing can reach the key.

Admission control admits only images `build.yml` signed, and the third-party images it names by digest, in all three (ADR 0010), so an image the list does not have cannot run there. What cannot be seen there is the first row: an older signed image of ours still running, a digest no result names, which admission does not stop.

### Its fences

- **The GitHub worker's reads, and no action.** The worker's main port acts in GitHub, so the sense asks its own door, on a port of its own (8083), which serves `moves` and `dependencyPulls` and nothing else; a NetworkPolicy opens it to the sense's pod alone.
- **Pods, listed, and nothing else.** Its account's one right is a ClusterRole, `patching-lists-pods`: list pods, never get, watch or anything else, bound by a RoleBinding in each namespace it reads and by no ClusterRoleBinding (`deploy/base/patching-reads-pods`).
- **Its own role.** `factory_patching` appends `patching.read` and nothing else, reads only its own events, and no other table; it is no member of `factory_worker`. Its password is in `postgres-patching`, which `make up` makes and the migrate Job sets.
- **Its NetworkPolicy** gives it the store, the collector, the API server on 6443 and the worker's door, and takes nothing in.

On the host, `factory patching --once` makes one pass against the cluster's GitHub worker and says what it appended, or why not: [on the host](../ON-THE-HOST.md#the-dependency-sense) has the commands.

## The pin watch

This repository's moves are the GitHub worker's to make ([its pin watch](GITHUB-WORKER.md#pins)), from the same moves read, which the worker keeps, so the watch's hourly pass and the sense's daily one page the alerts again only for a new scan run, a change to an alert, the run's artifact expiring, or a call while a run is going: one pull request of the App's on `factory/pin/<move>` for each move in the `worker`, `approval` or `cluster` lane, which replaces the version or digest at each of the move's pins and nothing else, as [its guard](GITHUB-WORKER.md#the-pin-guard) holds it; one issue for each move in the `issue` lane, a line no longer built, and one whose pins' lines it cannot write. It does not fight Dependabot: a move Dependabot's open pull request already makes, to the same target or a newer one, gets nothing, and a pin Dependabot reads with no High or Critical on a deadline is in the `dependabot` lane, Dependabot's alone. The review gate passes its pull request as `pin-move` when it proves the move from the pull request itself, and holds it for Martin otherwise ([approval routing](APPROVAL-ROUTING.md)). It takes only the moves its deployment names in `PIN_WATCH_ONLY` (or every one, `*`), and none while none is named. The app's moves are its line's.

## What it sends triage

Every pass that reads, the day changed or not, the sense sends each of the app's moves in the lane `line` that has a target to triage's inbox, as a `dependency` signal ([a move](TRIAGE.md#a-move)): the move as the signal names it, and the scan's findings, worst first, at most eight, with the rest and what the move leaves on its pins counted. A move with no target, or in any other lane, sends nothing. A lockfile's move is sent by its package, which the read takes from the alerts, in the `npm` ecosystem; an image's is `docker`, Node's own binary `node`. Only the fixed fields of an alert's message are sent, each checked against the signal's shape; a finding that does not fit is counted with the rest.

**The same send** is one move of one repository from one run of the scan, and has one id, derived from those three: a sense restarted on the same day sends each again under the same id, and the inbox keeps the first. Triage says it too, since the inbox prunes counted signals after three days: a signal that says what its ticket's last said is counted and appends nothing. A new run is a new send, counted on the ticket, or joining it when its target or findings changed.

Its role may send only its own sense's signals and reads none of the inbox (`0051_patching-sends.sql`). A send that fails fails the pass, the day appended, and the next pass sends again.
