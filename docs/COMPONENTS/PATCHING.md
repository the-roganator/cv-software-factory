# Patching

How the factory keeps what both repositories run and pin patched: the scan's moves, and the dependency sense that reads them each day. Part of the [factory plane](README.md#factory-plane). A **move** is one thing (a package, an image, Node, a chart, k3s) going from what is pinned to a target, in one repository, with every pin that names it: the unit of work, as a finding, one package and one advisory in one item, is the unit of evidence ([terms](../TERMS.md)).

## The moves

The daily [vulnerability scan](SECURITY-SCANNING.md) groups each day's findings with a fix into moves, a pure function of its results (`apps/factory/src/vulnerabilities/moves.ts`), each with its pins, from and to, what it clears and leaves by severity, its earliest deadline, how many of its findings are new today, and its lane, which says who moves it. It uploads them as `moves.json`, with every image it read (`scanned`), and each result's message names what fixes it and its move. The factory reads them only through the [GitHub worker's `moves` read](GITHUB-WORKER.md#for-patching), which checks the artifact against the alerts.

## The dependency sense

`factory patching` (`apps/factory/src/patching`), a worker of its own in `factory`, connecting to the store as its own role, `factory_patching`. As it starts, and each day at 05:30 UTC once the scan (04:17) has finished (`PATCHING_AT`), it:

- asks the GitHub worker, through [its door](GITHUB-WORKER.md#the-senses-door), for both repositories' moves and open Dependabot pull requests;
- lists the images every pod runs, by the reference its spec names and the digest its runtime resolved, in every namespace but three ([below](#the-namespaces-it-reads)), since an image the list lacks may run in any;
- compares the two, and appends the day as one event, `patching.read`, when it differs from the last it appended.

A read that fails, of either repository or of the cluster, appends nothing and says which failed in its log; it tries again an hour later, until the day's read comes round. A day that says what the last said appends nothing: a pod made again under a new name, or a Deployment scaled, is no new day while its row stands. It acts on no store of samples.

### The day

`patching.read` (`packages/events/src/schemas.ts`) holds, for each repository, the scan's run it was read from (its id, how it was started, its conclusion, commit and link), when the scan judged its moves, why it failed as its moves show it (a finding past its deadline, one due within a day, a new High or Critical with a fix, or `other`), its totals as `moves.json` gives them, copied and never worked out here (results with a fix, the moves and the moves in each lane, and the findings with no fix, excepted, past their deadline, due within a day, and new today at High or Critical with a fix and without), how many images it read, and its moves as `moves.json` gives them, with two additions: a lockfile's move's package, versions and pins, which the alerts give and the artifact withholds (`package`), and the open Dependabot pull request moving a move's pin, matched by the dependency and directory its branch names (`pullRequest`). The public view leaves a lockfile's move's package out until such a pull request is open, which names it anyway; everything else is as the scan's log has it.

Only the sense's role appends it, by a restrictive policy every role's insert must meet, and Martin's command line only as samples (`0050_patching.sql`): the Patching panel, Needs you, the alert rules and the pin watch read what waits and what is due from it, so no worker that untrusted input had turned can write a day in which nothing waits.

### What the cluster runs that the list does not say

Each is a row of the day, with no target, since each means the list or the cluster is wrong (`apps/factory/src/patching/compare.ts`, a pure function of the pods and the lists):

- **`unscanned-digest`**: a container runs a reference the list has, at a digest the scan never read: a tag rebuilt upstream since the scan, or since the pod pulled it. A pod's digest may be its index's or a platform's manifest's: the list gives every one the scan saw of each image.
- **`unlisted-image`**: a container runs an image no item of either repository names, or one whose repository the list names at other references only.
- **`not-running`**: a pin `main` holds that the cluster does not run yet, while it runs another reference of the same image instead: Argo CD after a merge, a k3s move not yet applied. The pin of an image no pod runs at all is no row, since an image may run only now and then (a runner's, a Job's); nor is one of a kind no pod runs (a workflow's, a build stage's, k3d's).

A reference is compared by its repository, normalised as Docker does (`postgres` is `docker.io/library/postgres`), then by its digest when the pod names one, or else by its tag. With a repository's list missing, as when its scan failed before it wrote one, the cluster is not compared (`compared: false`), since every image of it would look unlisted.

### The namespaces it reads

Every namespace the cluster has, `default` included, but three, which `PATCHING_NAMESPACES` lists and the RoleBindings bind; a test holds the two together, and fails for a namespace `deploy/` makes, or the cluster has of its own, until it is in one or named as left out. A namespace made later is not read until then.

- **`runners`**: an agent step's Job carries its job token in its spec, as a value (a pin step's and a lockfile's carry none), so whatever lists pods there can read live tokens; only the line may.
- **`red-team`**: only the red-team harness's two attack pods run there, each held by an admission rule to one of two images and a pinned command, the unsigned one refused as it is created.
- **`scoreboard`**: the answer key's namespace, where no role of ours is bound but the line's list of its Events, so that nothing can reach the key.

Admission control admits only images `build.yml` signed, and the third-party images it names by digest, in all three (ADR 0010), so an image the list does not have cannot run there. What cannot be seen there is the first row: an older signed image of ours still running, a digest no result names, which admission does not stop.

### Its fences

- **The GitHub worker's reads, and no action.** The worker's main port acts in GitHub, so the sense asks its own door, on a port of its own (8083), which serves `moves` and `dependencyPulls` and nothing else; a NetworkPolicy opens it to the sense's pod alone.
- **Pods, listed, and nothing else.** Its account's one right is a ClusterRole, `patching-lists-pods`: list pods, never get, watch or anything else, bound by a RoleBinding in each namespace it reads and by no ClusterRoleBinding (`deploy/base/patching-reads-pods`).
- **Its own role.** `factory_patching` appends `patching.read` and nothing else, reads only its own events, and no other table; it is no member of `factory_worker`. Its password is in `postgres-patching`, which `make up` makes and the migrate Job sets.
- **Its NetworkPolicy** gives it the store, the collector, the API server on 6443 and the worker's door, and takes nothing in.

On the host, with Postgres forwarded, `kubectl proxy` running and the GitHub worker on the host with `PATCHING_PORT` set, `factory patching --once` makes one pass and says what it appended, or why not (AGENTS.md).

### Not yet

The day's cards in Needs you and its messages to Martin's phone (task 32), the pin watch that opens a move's pull request (task 33), and the app's moves sent to triage's inbox (task 35), for which the inbox already knows the sense by name, `dependency`.
