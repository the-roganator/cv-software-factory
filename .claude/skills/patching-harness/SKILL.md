---
name: patching-harness
description: Prove patching end to end on two scratch copies of the repositories and a scratch cluster of their own — make or check the copies, build a baseline from a real commit, reset, run one test, a batch or the whole pass, read a verdict, take a newer main. Use before any patching change opens a pull request, and when reading or re-running a test of TESTS.md.
---

# The patching harness

Patching is proven on the real thing, not on its own tests: a real scan, real pull requests, the real gate and merge queue, a real deploy and the next scan. That happens on two public scratch copies, `the-roganator/cv-software-factory-scratch` and `the-roganator/cv-worlds-worst-website-scratch`, and a k3d cluster of their own, `software-factory-scratch`, which the copies' `main` deploys. [`TESTS.md`](TESTS.md) is what must pass: it is Martin's, and changes only with him. A change to patching is tried here, by the tests it touches and then the whole pass, before its pull request opens.

## Never

- **Never the real cluster.** Every command names the context `k3d-software-factory-scratch`; never `k3d-software-factory`. Never run `make` for the scratch cluster from a checkout of this repository: only in the factory copy's clone, `work/factory` in the state folder, whose Makefile names the scratch cluster, as `bin/copies.sh` does (it refuses a clone that names the real one).
- **Never `make upgrade-cluster` in the copy.** The copy pins an older k3s and k3d on purpose, for test 14, and it would move the scratch cluster down to them.
- **Never write to the real repositories.** The scripts write only to a repository whose name ends `-scratch`, and refuse any other; the real two are read, to build a baseline and to close what they closed.
- **One session at a time.** A run resets the copies and restarts the scratch cluster's workers; two at once read each other's pull requests as their own.
- **Look at the shared runners before a reset.** The copies queue on the organisation's free runners beside the real repositories: `gh run list -R the-roganator/cv-software-factory --status queued`. A reset or a batch starts a dozen runs; when the real ones are waiting, wait.
- **Never `kubectl delete job migrate`** on the scratch cluster: its Argo CD finalizer hangs the delete and every sync behind it.

A pass's timings are part of its verdict: keep the Mac quiet while one runs.

## What is where

The skill's files are tracked; what a run makes and keeps is in the **state folder**, the main checkout's git-ignored `scratch/patching-harness/` (`PATCHING_HARNESS_STATE` names another), found the same way from any worktree.

| Tracked, beside this file | |
|---|---|
| `TESTS.md` | The tests, Martin's. |
| `baseline.env` | The baseline: the real commits, the merges reverted, the Dependabot pull requests kept. |
| `app.env` | The scratch cluster's GitHub App's public ids. Its key is in the Keychain, `scratch-factory-github-app-key`. |
| `staged/` | The tests' set-ups no real merge can put back, as patches: `factory/`, `app/` on every baseline, `factory-x2/`, `app-x4/` on X2's and X4's alone. |
| `bin/copies.sh` | The copies and the scratch cluster: build, check, reset, pin-images, the store. Its header lists every command. |
| `bin/harness.ts`, `bin/catalogue.ts` | A run of tests and its verdicts; the catalogue says how each test's outcome is read. |
| `bin/forge.ts` | The forged pull requests the gate must hold (N3a to N5, X1a, X1b); the harness calls it. |
| `bin/confirm.sh` | The whole pass, in batches. |
| `bin/level.sh`, `bin/auto-merge.sh` | The scratch line's autonomy level and auto-merge switch, written to its store. |

| In the state folder | |
|---|---|
| `runs/<run>/` | A run's `log.txt`, `state.json`, scans and each worker's log (`logs/`). |
| `work/` | The two baselines' clones, the scripts' logs, and `store-clean.dump` (Martin's passkey's public key and his sessions: it never leaves the Mac). |
| `images.env`, `images.prev.env` | The images each copy's own build made, from `pin-images`. |
| `batch.env` | A batch's `PIN_WATCH_ONLY`, which a reset gives the scratch worker, and a baseline's `STAGED_EXTRA`, read after `baseline.env`. `confirm.sh` writes it; nothing writes a tracked file. |
| `staged/<side>/*.patch` | Set-ups not committed (one being tried, or a local diagnostic): `build` applies them in name order with the committed ones. |

Every command below runs from `bin/`, the `.ts` ones as `mise exec -- node <script>`.

## The copies and the scratch cluster

`./copies.sh status` says where each copy's `main` and `baseline` are and what is open; `kubectl --context k3d-software-factory-scratch -n argocd get app root` says whether the cluster is Synced and Healthy; its console is `https://console.localhost:9443` (a browser keeps one sign-in per host, so signing in there signs you out of the real console). With both, the copies are ready.

From nothing, once: `./copies.sh build`, `check`, `create` (the repositories, their settings, keys and variables) and `up` (the cluster, by the factory copy's own `make up`, with the scratch App's key from the Keychain; `./copies.sh app` makes a new App, which Martin creates and installs on the two copies alone, and writes `app.env`). Then Martin enrols his passkey (`make enrol` in `work/factory`) and sets the controls in its console (Guarded, auto-merge on, new work on), and `./copies.sh store-save` keeps that store as the clean point every reset can go back to. Then a baseline (below).

A copy is the real repository at the baseline's commit with the vulnerable pins put back, every real name renamed to the copy's (`rename.pl`), the cluster's names, ports and App made the scratch cluster's (`cluster.pl`), and what the renames invalidate made again (formatting, samples, the scan's recorded answer, the refusal records' hashes, `rehash.ts`). The app calls the factory copy's workflows at the factory baseline, so every gate a copy's pull request meets is the copy's code. The copies have the real ones' rulesets, environments and labels, from the baseline's own `scripts/github-settings.ts` (`./copies.sh settings`).

## A baseline

A baseline is a real commit of each repository (`FACTORY_FROM`, `APP_FROM`), the merged moves reverted so their pins are vulnerable again (`*_REVERTS`), and the patches in `staged/`, each a commit, applied after the reverts and before the rename. To build one and put the copies on it:

```sh
./copies.sh build && ./copies.sh check && ./copies.sh reset && ./copies.sh pin-images
kubectl --context k3d-software-factory-scratch -n argocd get app root   # until Synced Healthy
```

`check` is `make check` in both clones. `pin-images` builds each copy's images on its `main`, pins their digests in a commit on top, and makes that the baseline. A set-up patch is written against the real repository at `FACTORY_FROM` or `APP_FROM` with the reverts applied, naming the real repositories, with `# <why>` as its first line; each must still pass `make check` (the inventory's `--unlisted`, a frozen install, the scan's recorded answer), and must leave the app's `package.json` naming the registry's ranges alone (no alias, tarball, folder or git source), or the pin step refuses every lockfile move.

## Reset

`./copies.sh reset [factory|app] [--store]` puts a copy back to its baseline and closes everything open; `--store` also restores the scratch store (`store-restore`, which then runs the baseline's migrations). A run resets for itself. A reset closes pull requests as Martin's login and then retitles them `chore(reset): …` and clears their marks (`forget-closed`), so the watches open them again. It keeps the Dependabot pull requests the tests need (`DEPENDABOT_KEEP_*`) and closes the rest, and any the real repository closed.

## Running tests

Set the level first: `./level.sh guarded` (the default for every test), `supervised` or `lights-out`; the worker reads it within a minute.

- **One factory test, or a few:** `node harness.ts factory --only 1,2` (75 minutes at most): it resets the factory copy, scans, forges (name `N3a,N3b,N4,N5` to run the forgeries, or add `--no-forge`), restarts the worker, watches, and scans again. The watch ends once every test is decided (a move merged and deployed; a refusal, forgery or held major unmerged and unqueued with its checks and the gate's verdict in, and, but for a forgery, its checks green and the worker's word that it waits for the level or the verdict), and otherwise at the limit (`--limit`, 60 minutes); W1b watches its own 100. `--lights-out` expects the majors (4a, 4b) merged; without it they must be held.
- **One app test:** `node harness.ts app 13` (about 40 minutes, W3 an hour). It resets the app copy, restores the store, promotes the app's release of its baseline whole and waits for it to be Healthy, and tells the line which ticket to take. `--with X1a,X1b` carries the app's forgeries beside it; `app X1a --with X1b` runs them alone. One at a time: each needs the line to itself.
- **A batch** is a few factory tests on the baseline as built, with the pin watch taking only their moves: `node harness.ts only 1,2,5` prints a `PIN_WATCH_ONLY=…` line, which goes in the state folder's `batch.env` in place of any there; then `factory --only 1,2,5`. Its reset of the factory copy writes the line to the ConfigMap `scratch-pin-watch`, from which the scratch worker reads it as it starts (no commit holds it, and Argo CD does not track it), and the pre-flight refuses a run whose tests' moves it leaves out. `batch.env` stays until it is changed: take the line out for every move, which a missing ConfigMap is not (the worker then takes none). Tests 6, 7a, 7b and 9 share one pull request, so name them together.
- **The whole pass:** `./confirm.sh <a folder for its logs>`: one baseline, then batches A (1, 2, 3, 5, 14a and the forgeries), B (4a, 4b, 6, 7a, 7b, 9, 14b), C (the majors at Lights-out), D (Supervised queues nothing but the deploy pin; it watches until the deploy pin has merged and each move's pull request has its checks in and the worker's word on why it waits, 35 minutes at most), the six app tests with the forgeries X1a and X1b beside 13, and W (W2 to W4, then W1). `STEPS="C D"` runs some; `STEPS=X` and `STEPS=X4` run X2 and X4, each on a baseline of its own.

The recovery tests W1 and W2 turn a check red on purpose, by repository variables the factory copy's title check reads (`staged/factory/15-…`). `node harness.ts variables W1a,W1b` prints them; `confirm.sh` sets them for the run and clears them on any exit, and the harness refuses a run while one is set that its tests do not need. W1 is a batch of its own (`only W1a,W1b`), never beside test 2 or 3. X2 needs `STAGED_EXTRA=x2` in `batch.env`, and X4 `STAGED_EXTRA=x4` and no `check` (the app's own Node pin test refuses its half-made state by design); take the line out after, or every later baseline carries it, which the harness refuses. X3 is not staged: no real pin separates the publisher's Critical from Trivy's, so unit tests prove it.

## Reading a verdict

`node harness.ts summary` prints one line a test from its latest finished run; `report <run>` a run's lines; `resume <run>` carries on a stopped one; `reread <run>` judges a finished run again, reading the cluster as it is now, so a deploy's time is right only during the run.

Believe a verdict only once GitHub and the cluster say the same. A run checks what it stands on before its clock starts (the store at the baseline's newest migration, the app's release of its baseline whole, its staged extras those its tests ask for) and stops with "pre-flight, no verdict" on a set-up fault: mend the set-up and run again. A surprising PASS or FAIL is checked against the pull request, its checks and the worker's log in `runs/<run>/logs/` before anything is changed for it: a verdict is the harness's reading, and the harness can misread as surely as the code can fail.

## Taking a newer main

1. Set `FACTORY_FROM` and `APP_FROM` in `baseline.env` to the new commits. `./copies.sh build` says which revert or staged patch no longer applies: a revert whose move `main` reverted itself goes, and a patch is written again against the new commit.
2. Check each test still starts from a vulnerable pin: `catalogue.ts` names each test's pins. A move `main` has merged since needs its merge added to `*_REVERTS`.
3. `check`, `reset`, `pin-images`, then `./copies.sh settings`: the copies' rulesets and disabled workflows follow the baseline's code. A migration `main` renumbered needs the scratch store's `schema_migrations` row renumbered too.
4. The whole pass.

## Traps

- **The clock starts at the scan the pull requests come from.** A reset that pushes the baseline to `main` starts a scan, which the worker opens its pull requests from: the run stands on that scan and starts its clock there. A reset that finds `main` at the baseline already pushes nothing, and the run dispatches a scan of its own, after code scanning has an analysis of `main`; pull requests the worker opened from an earlier scan of the same commit are then older than the clock. The run's log says which scan it took, and why.
- **A scan can fail on a registry's rate limit** and leave no moves. Run again with `--no-reset`, with `resetAt` in the run's `state.json` set to the reset's time, or pull requests opened before the new scan are missed. A scan's conclusion reads `failure` whenever it has findings: that is not this.
- **A `platform` run can hang** on the Argo CD install's image pull and end at the step's or job's limit; the merge queue's and the worker's recoveries then run it again. The failed job's step `Why: …` carries the runner's figures: `gh api repos/<copy>/actions/runs/<run>/jobs --jq '.jobs[].steps[].name'`.
- **The first deploy pull request after a reset is red by design** (`lint, types, tests`): its base reached `main` by a force-push, not the merge queue. The worker runs its checks again twice and says it is out of runs, about a quarter of an hour after every factory reset; that is no fault.
- **A ticket restored with the store is days old.** The harness takes the open ticket after four minutes and times "stuck" from the take.
- **Argo CD puts back what you take away** within seconds, Postgres among it. To keep the store away for a test, delete its pod repeatedly.
- **Postgres goes to 18.7 in test 1 and back to 18.6 at each reset;** `store-restore` strips what 18.6 refuses.
- **An ordinary work item on the app before a run** leaves a fix the next reset takes back, and the canary aborts that release. The pre-flight promotes the baseline's release whole.
- **Dependabot opens pull requests on the copies** at no set time, and a fresh push opens about ten at once: `DEPENDABOT_KEEP_*` keeps only those the tests need.
