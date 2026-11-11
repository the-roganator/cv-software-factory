---
name: try-the-line
description: Try the line or one agent on the Mac — the bench, the local cluster with unmerged images or a stack of them, a fix on a work item held for it, a soak, stopping the line or reaching a cap — and undo it all afterwards. Use before changing the local cluster for a run, and when watching or checking one.
---

# Trying the line on the Mac

Three ways in, from smallest: one agent's step on the **bench**, with no cluster; the **smoke run**, a coder in the cluster on a seeded off-by-one; and **the line on the local cluster**, on images built from a branch. The commands for the host's workers, the smoke run and `soak-check` are in the root `AGENTS.md`; this skill adds how to run them safely and leave nothing behind.

The local cluster is `k3d-software-factory`, and it is disposable. Unmerged code is tried there on images built locally, not merged first; merging stays Martin's call. Pushing, opening pull requests and filing issues still need his yes.

A try is the proof, and merging ratifies it: a change to what runs on the cluster is tried here before its review, live where the fault can only show live ([A live try](#a-live-try)), and nothing is learned from a merge and a deploy that a try could have shown. One session holds the cluster at a time, and says so where the others read it (the board's notes, `scratch/workflow/board.yaml`, under `sessions`), from before the first change until the undo list is ticked.

The helpers are in `bin/` beside this file: `try` begins and ends a try on the local cluster ([below](#try-begin-and-try-end)), `k` is kubectl on the local cluster, `argocd-core` is Argo CD's CLI on it (`--core`, with no login), `q` is psql on its store, `poll` and `watch` follow a run, and `trace.js` prints a step's conversation.

**Which model.** A try, to see that work runs as it should, runs on Claude: it is faster, and Martin has agreed to its spend for tries. Qwen is for what runs unattended, a night's soak, for a run that must spend nothing (`soak-check --no-spend`), and for working on an agent's prompt on the bench, which root `AGENTS.md` starts on Qwen and records on Claude after. Note what a try on Claude cost (`bin/poll`, or the bench's own `model_calls`), and say so.

## Before you change anything

Copy the checklist at the end into `scratch/` and record each value before you change it: the sync policy, every image, every env variable. Tick each line as you put it back. What `bin/try begin` changes it records itself, and `bin/try end` puts back: the list then names the try's state file for those lines, and holds by hand only what the script does not do.

To change the cluster in auto mode, Martin may add `Bash(kubectl --context k3d-software-factory *)` to `.claude/settings.local.json`. Without it, ask him.

## The bench: one agent's step, no cluster

`factory line bench <agent> <fixture>` runs the runner's own prepare and agent steps on the host, on a fixture of invented work (`apps/factory/src/line/bench/fixtures.ts`), against a gateway on the host; alone, it lists the fixtures.

1. A throwaway Postgres for the job token and `model_calls`:
   ```sh
   docker run -d --name sf-bench-pg -e POSTGRES_USER=factory -e POSTGRES_PASSWORD=factory -e POSTGRES_DB=factory -p 127.0.0.1:5433:5432 "$(awk '/image:/{print $NF}' deploy/base/postgres/statefulset.yaml)"
   DATABASE_URL=postgres://factory:factory@127.0.0.1:5433/factory LINE_PASSWORD=line GATEWAY_PASSWORD=gateway node packages/store/src/migrate.ts
   ```
   A new store's line has not started, and the gateway answers no agent until it has: start it as Martin's command line's role, which the owner readies with a password of its own:
   ```sh
   printf operator | PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=factory PGUSER=factory PGPASSWORD=factory node packages/store/src/operator.ts factory_operator
   PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=factory PGUSER=factory_operator PGPASSWORD=operator node apps/factory/src/cli.ts line start --reason "The bench"
   ```
2. A gateway on Claude:
   ```sh
   PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=factory PGUSER=factory_gateway PGPASSWORD=gateway \
     GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/bench-cassettes PORT=8180 OTEL_SDK_DISABLED=true \
     ANTHROPIC_API_KEY="$(security find-generic-password -s anthropic-api-key -w)" \
     node apps/factory/src/cli.ts gateway &
   ```
   For Qwen (LM Studio on 127.0.0.1:1234), which spends nothing, as for working on a prompt, drop the key and add `ALL_LOCAL=true`. For replay only, `GATEWAY_MODE=replay`.
3. The step: `GATEWAY_URL=http://localhost:8180 PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=factory PGUSER=factory_line PGPASSWORD=line node apps/factory/src/cli.ts line bench coder off-by-one`.

A step run again replays every call. A tool that prints a time the cassette key does not know ends a replay at that call: add a pattern to `UNSTEADY` in `gateway/agent-cassettes.ts`. Only cassettes made from invented work may be committed.

The bench's calls go into its own Postgres, on the same Anthropic key as the cluster: note what a Claude run cost before removing the container.

LM Studio's settings are part of a run. Save them as the model's defaults (My Models, the model's gear), not on the loaded model, which loses them on a reload: Reasoning Effort Medium (the only effort Qwen runs at: the gateway sends it none), Temperature 0.6, Context Length 119,552, Max Concurrent Predictions 1, Preserve Thinking on. `lms ps` and `lms server status` check them.

## The line on the local cluster

The line runs in the cluster only: its agent pods may reach only the gateway and the handback.

### `try begin` and `try end`

The mechanical half of the steps below is a script, so that what a try changed is put back by one command that needs nothing from the session that began it:

```sh
bin/try begin <branch> [--only <deployment>[,…]]… [--apply <Kind>/<name>[,…]]… [--env <deployment>:<NAME>=<value>]… --holder <your key>
bin/try status
bin/try end
```

`try begin` refuses while a try is open, by the script or by hand (`root` paused, a policy off Deny, a pod on a `local-` image), while the board's `cluster.holder` is not `--holder` (`TRY_HOLDER`), and on a branch whose render of `root`'s overlay differs from `main`'s on an object it is not told to apply (each named with the `--apply` that would take it, or as one only you can apply), drops one, or adds a migration, unless `--by-hand` says those are in your undo list. A migration the store does not hold under the branch's number and name is warned of by `begin` and by `status`: run for the try, its number stays recorded in the store, and if a different migration of that number merges first, `main`'s never runs on this store until `schema_migrations` is put right by hand. Then it records, in `~/.config/software-factory/try/state.json` and before the first change, `root`'s sync policy, each image policy's actions, each deployment's images and every variable it will write, the line's state, take and last seq; builds the images those deployments run (step 1) from the branch's commit (the local branch's, else origin's) in a worktree of its own, loads them, and finds each on the node, by a digest reference it makes there (step 6), before pausing `root` (step 2), setting `factory-images` to Audit (step 3) and pointing the deployments at them (step 5), each variable that names a moved image (`RUNNER_IMAGE`) following it. `--apply Kind/name` takes that object from the branch's render, in every namespace the render has it, and records the live copy it replaces, or that there was none. It adds a new object with `root`'s tracking id and replaces a changed one whole, so a field the branch drops is gone for the try. It does this once `root` is paused and before any deployment is pointed. It never takes an object in `website`, `scoreboard`, `flagd` or `argocd`, an admission policy of any kind, a webhook, a Secret, a Namespace, a CRD, a Job (the migrate Job is step 7's), or a cluster-wide object other than a ClusterRole or ClusterRoleBinding: those stay by hand. Of a name with copies on both sides (a RoleBinding in `factory` and in `flagd`), it applies the copies it may and records the rest as by hand. `begin` and `status` print each with the exact command that applies it and the one that undoes it, reading files kept beside the state. `try end` ends only once each is undone, and names any that is not. A name with no copy it may apply is refused. The render is compared with `main`'s at the commit the branch left it. A new worker's ServiceAccount, RoleBindings, NetworkPolicy and Deployment, and the neighbours it changes, are the try's to put back (step 8, done by the script); `--only` then names a Deployment the try added as it names a live one. Without `--only` it moves every deployment on the `factory` and `factory-runner` images, or, given `--apply`, none; `--only console` or `--only probes` builds that one's image too. `--env` sets a variable for the try, as step 4's dry run or step 10's model needs, on the container named after its deployment.

`try end` needs nothing but the state file and the cluster. It refuses, changing nothing, while the line is started on the try's images, or when the try moved the line and the store cannot be read to say: stopping it is Martin's command line's (`make stop-the-line`), and the script never writes the store. Otherwise it deletes the runner Jobs and attack pods on the try's images, deletes each object the try added and replaces each it changed with the copy recorded before, last applied first, puts each deployment's images and then its variables back, sets `factory-images` back and gives `root` its policy, and waits, ten minutes at most for all of it, the rollouts included (`--timeout`, twenty at most), for `root` Synced and Healthy, each policy as recorded, no pod or Job in `factory`, `runners` or `red-team` on the try's images, each object it added gone and each it changed as it was, and its images gone from the node, by every name the node holds for their digests, and from the Mac. Nothing it applied is left to `root`'s prune. Only then does it delete the state file; otherwise it says what is not back, keeps the file, and can be run again. It says the line's state and take and the work items with events since the try began, for Martin. `try status` says what is open, since when, by whom, every object it added or changed, and what is changed now.

What stays in your hands: whether the try is dry or live and what it takes (steps 4 and 11, and [A live try](#a-live-try)'s terms), migrations (step 7), manifests not named with `--apply` (step 8), alert rules (step 9), stopping and starting the line, and what to watch. A begin killed part way leaves its state file at `beginning`, and `try end` puts back whatever it had changed.

### By hand

1. **Build** `factory` and `factory-runner` from one commit, in a worktree, and import them:
   ```sh
   T=local-$(git rev-parse --short HEAD)
   docker build -f apps/factory/Dockerfile -t ghcr.io/the-roganator/cv-software-factory/factory:$T .
   docker build -f apps/runner/Dockerfile -t ghcr.io/the-roganator/cv-software-factory/factory-runner:$T .
   k3d image import -c software-factory ghcr.io/the-roganator/cv-software-factory/factory:$T ghcr.io/the-roganator/cv-software-factory/factory-runner:$T
   ```
   Build `console` too if its code changed.
2. **Pause Argo CD** on `root` only, which owns every factory deployment: `bin/argocd-core app set root --sync-policy manual`. If an operation on `root` sticks, on a hook its own sync must fix, end it with `bin/argocd-core app terminate-op root`, which returns before the operation has ended, wait for it with `bin/argocd-core app wait root --operation`, and sync only what it needs with `bin/argocd-core app sync root --resource <group>:<kind>:<namespace>/<name>` for each resource (a core kind's group is empty: `:ConfigMap:factory/<name>`); never write `operation` or `status` by hand.
3. **Admission:** images built here are unsigned, and admission control refuses them in `factory`, `runners` and `red-team` (ADR 0010). Switch the factory's policy, and only it, to audit: `bin/k patch imagevalidatingpolicy factory-images --type merge -p '{"spec":{"validationActions":["Audit"]}}'`. It covers `factory`, `runners` and `red-team`. Never `website-images`, `scoreboard-images` or `flagd-images`: nothing built on the Mac runs in `website`, beside the answer key in `scoreboard`, or in `flagd`, and the scoreboard stays on `main`'s image.
4. **Dry run or live**, decided before anything else can act. A dry run (`GITHUB_DRY_RUN=true` on `github`, `LINE_MODE=dry-run` on `line`; optionally `GITHUB_DRY_RUN_CHECKS_SECONDS` and `GITHUB_DRY_RUN_MERGE_SECONDS` to go round faster) shows the line going round and touches nothing in GitHub, and it is enough for an agent's step, a hold, a card. A live try leaves both as `main` sets them, and is the proof for what a dry run cannot show ([What a dry run cannot show](#what-a-dry-run-cannot-show)): [A live try](#a-live-try) has its terms. On a new cluster the line has not started, and takes nothing until `make start-the-line` (step 11).
5. **Point** `line` (its container, its `runner-image` initContainer and `RUNNER_IMAGE`), `gateway` and `github` at the new images with `kubectl set image` and `set env`. Point `admin` at the `factory` image too when the branch changes a route the admin service serves, such as `POST /admin/attacks/:attack`, which the console's Guardrails panel calls: the console reaches whatever image `admin` runs, and `main`'s answers a route it lacks "Not found". For a try of the red-team harness, point `red-team` as well: its container on `factory`, and its runner image by digest (step 6). Every `set env` in these steps names its container: `-c line`, `-c gateway`, `-c github`, `-c console`, `-c admin`, `-c red-team`. Without `-c` it writes every container, the line's `runner-image` init container included, and Argo CD never removes a field it does not own, so a `RUNNER_IMAGE` or `LINE_MODE` left there outlives the run and fails `make admission-ready`. Undoing one takes the same `-c`: `bin/k -n factory set env deployment/line -c line NAME-`.
6. **An image by digest.** Some of admission's rules admit an image only as a digest reference, and an image imported with `k3d image import` has only its tag in the node's containerd. `factory-red-team-pods` (`deploy/base/admission/factory/red-team-pods.yaml`) is one: it admits the harness's pods on the runner image only as `factory-runner@sha256:…`, so `red-team`'s `RUNNER_IMAGE` and its `runner-image` initContainer take a digest reference. Give the local image one on the node, from the digest containerd lists for its tag, and point at that; the undo removes it:
   ```sh
   R=ghcr.io/the-roganator/cv-software-factory/factory-runner T=local-$(git rev-parse --short HEAD)
   D=$(docker exec k3d-software-factory-server-0 ctr -n k8s.io images ls "name==$R:$T" | awk 'NR>1 {print $3}')
   if [ -z "$D" ]; then echo "no $R:$T on the node: import it first (step 1)" >&2; else
     docker exec k3d-software-factory-server-0 ctr -n k8s.io images tag "$R:$T" "$R@$D"
     bin/k -n factory set image deployment/red-team runner-image="$R@$D"
     bin/k -n factory set env deployment/red-team -c red-team RUNNER_IMAGE="$R@$D"
   fi
   ```
   The rule takes any digest of the runner's repository, so this reference passes it. The one image it pins by digest is the unsigned image attack 5 asks for (`unsignedImage`, kept in step with `policy/attacks.ts`): a branch that changes that image changes the pin, and its copy of the rule is applied as step 8 says, or this rule refuses the attack's pod for an image it does not name, which is not the refusal by signature the attack tests. With `factory-images` on Audit (step 3), admission admits that unsigned image, so attack 5 is tried with `factory-images` on Deny for its one launch (`bin/k patch imagevalidatingpolicy factory-images --type merge -p '{"spec":{"validationActions":["Deny"]}}'`), and on Audit again once it has finished. On Deny, admission refuses every new pod on a local image, a restart or a runner Job the line starts included, so stop the line, or let it take no work item, meanwhile; the pods already running keep running. The harness's attack pods are bare pods in `runners`, not Jobs: the undo deletes them.
7. **Migrations:** compare `select * from schema_migrations` with `packages/store/migrations`; if the branch adds one, a copy of the `migrate` Job runs it, on the branch's console image. The copy comes from the branch's render of `root`'s overlay, never `main`'s or the live Job: a branch that changes the Job (a new role's password from its Secret) needs its own, or the migration runs without what it needs. Running it writes the live store, so it is Martin's write: give him the command, with the Job's name, and what its log must say (`Applied <n>_<name>.`). It stays applied after the try, and its number with it (`try begin` warns of the risk); the copied Job is deleted after.
8. **Manifests the branch adds or changes** that are not live: Argo CD applies only `main`. Apply each by hand from the branch's render of `root`'s overlay, carrying `root`'s tracking id, so that `root`'s auto-prune removes one the branch added, and its self-heal puts back `main`'s copy of one it changed, when the undo gives `root` its sync policy back. `git diff origin/main...<branch> --stat -- deploy/` lists them. The id is `root:<group>/<Kind>:<namespace>/<name>` for a namespaced resource and `root:<group>/<Kind>:argocd/<name>` for a cluster-scoped one, with the group empty for a core kind (`root:/Namespace:argocd/factory`), as the live ones show (`bin/k get validatingpolicy -o yaml`); the name is the rendered one, after the overlay's prefix (`factory-red-team-pods`). One name can be in several namespaces (`default-deny` is), so give the namespace of a namespaced one. In the branch's worktree:
   ```sh
   root_manifest() { # <Kind> <name> [namespace]: one resource of root's overlay, with root's tracking id
     kubectl kustomize deploy/overlays/local | node --input-type=module -e '
       import { parseAllDocuments, stringify } from "yaml";
       const [kind, name, ns] = process.argv.slice(1);
       let text = ""; for await (const chunk of process.stdin) text += chunk;
       const found = parseAllDocuments(text).map((d) => d.toJS())
         .filter((d) => d?.kind === kind && d.metadata.name === name && (!ns || d.metadata.namespace === ns));
       if (found.length !== 1) { console.error(`${found.length} ${kind} ${name} in the render: name its namespace`); process.exit(1); }
       const [r] = found;
       const group = r.apiVersion.includes("/") ? r.apiVersion.split("/")[0] : "";
       r.metadata.annotations = { ...r.metadata.annotations, "argocd.argoproj.io/tracking-id": `root:${group}/${kind}:${r.metadata.namespace ?? "argocd"}/${name}` };
       process.stdout.write(stringify(r));' "$1" "$2" "${3:-}"
   }
   root_manifest ValidatingPolicy factory-red-team-pods | bin/k apply -f -
   ```
   The render pins `main`'s images, so applying a Deployment the branch changes takes it off the local images: point it again after (steps 5 and 6). Record each one for the undo, which checks that the added ones are gone and the changed ones are `main`'s again.
9. **Alert rules.** When the branch adds or changes an alert, its rules (`deploy/base/telemetry/values/prometheus-rules.yaml`, generated from `apps/factory/src/alerts/rules.ts`) are tried too, so a page goes end to end: the alert reaches Alertmanager, and Martin's phone through Pushover once "Alerts to your phone (Pushover)" is on in the console's Controls. Otherwise nothing pages during the try. They reach Prometheus as Helm values of the `prometheus` Application, read from this repository at `main`, which `root` owns and so leaves alone while paused. Point its values source at the branch: `bin/argocd-core app set prometheus --source-position 2 --revision <branch>`. Argo CD reads only GitHub, so the branch must be pushed, which needs Martin's yes unless the run already pushes its branches (the implement skill's build-only workers do). The source carries every values file the Application reads, not only the rules: note in the undo list anything else the branch changes there (`git diff origin/main...<branch> --stat -- deploy/base/telemetry/values deploy/overlays/local/values`), since the try runs with it too. The Application syncs itself, writing the rules into the `prometheus-server` ConfigMap in `telemetry`, and Prometheus reloads them itself within half a minute of the file changing (`config.auto-reload`); `bin/k -n telemetry get cm prometheus-server -o yaml | grep <alert>` shows them there: wait for it before the run starts. `root`'s sync puts `main` back as its revision.
10. **The model:** none of them has `ALL_LOCAL` for Claude, a try's model; `ALL_LOCAL=true` on `gateway`, `line` and `console` for Qwen, a soak's. The gateway and the line must match, since the line sets a step's bounds from it; the console's settings page says from it that every agent is on the local model. Stop the line before switching, so no step straddles the change.
11. **The work item:** `make take-the-line ONLY=<number> KUBECTL="kubectl --context k3d-software-factory"`, which sets Martin's take to Just one, as Controls would, chosen by the line's own rule (the oldest open ticket of the highest severity not yet on the line), skipping duplicates of a defect already fixed. Note the take it replaced, for the undo (`make take-the-line EVERY=1`, or `NEXT=<n>`, puts one back; the next few count again from then). On a new cluster, set it before `make start-the-line`, so the line takes only that one from its first pass. Never answer a hold in Martin's name to get one moving: take the next ticket instead. The one exception is below, a fix tried on the work item held for it.

Run one work item at a time: two steps on one LM Studio halve its speed. The dry-run GitHub worker keeps its pull requests in memory, so a restart forgets them and reuses their numbers, issues included. `make stop-the-line` and `make start-the-line` need `KUBECTL="kubectl --context k3d-software-factory"`, and a stopped line also stops triage.

**The smoke run** posts to the line's step API (root `AGENTS.md`) with `"round"`: a job's name, and so its token, is used once, so each smoke run on the same commit needs a new round.

## What a dry run cannot show

A dry run goes round, but some of what the line does live never happens in it (`github/dry-run-reads.ts`):

- **Its gate passes everything:** the review check on a pull request it made passes as `low-risk` (`exact-pin` for a deploy pull request), so a merge held for risk tags or by the review gate's refusal is never seen, nor is a conflict, which none of its pull requests has, or a dequeue for a check that failed in the queue.
- **It fails no gate:** every required check on its commits passes `GITHUB_DRY_RUN_CHECKS_SECONDS` after it.
- **No deploy pull request carries its fix:** its merges never reach the app's `main`, so what the line does with the deploy pull request after a fix it merged is not seen.
- **Its merge comes on its own clock:** `GITHUB_DRY_RUN_MERGE_SECONDS` after the line adds the pull request to the queue, or after it is readied, whatever the autonomy level, so a hold for Martin's merge at Supervised lasts only that long.

What stands in for each: the bench, for an agent's step; a read of GitHub as it is, through the GitHub worker on the host (`POST /v1/reads/<read>`, root `AGENTS.md`); the tests; and, for what none of these reaches, a live proof, named in the brief before review (the implement skill's "Before starting").

## A live try

A live try runs unmerged images with `LINE_MODE=live` on `line` and `GITHUB_DRY_RUN=false` on `github`, as `main` sets them (`deploy/base/factory/github.yaml`): the line takes the real work item, the coder opens a real pull request in the app's repository, the gate judges it, and after the merge the App opens the deploy pull request, which waits for its checks, the gate's `exact-pin`, and the line or Martin to queue it, before Release has a rollout to watch. It is the proof for a change to how the line acts in GitHub (a hold's answers, a replan, what the coder does with a spec, the gate's reading of a pull request), which a dry run never shows, and it is run before review, on the work item the fault was found on, so the whole class shows in one pass rather than one fault per deploy. Martin decided this on 2026-11-08; it needs no further yes, and the terms are these:

- **Everything else in this skill holds.** The undo list from the first minute; images built from the top branch, tried as they will merge; `factory-images` on Audit and no other policy; `root` paused; a held work item answered by Martin in the console, never in his name. The gate and his autonomy level bound the unmerged line exactly as they bound the merged one, so a wrong pull request from it is held as any wrong pull request is.
- **What it writes is real.** A merge it makes in the app's repository is a merge, and a deploy pull request follows it, held as any is until it is queued: say so to the session that directs the try, with the seq, before the step that would merge, so Martin knows a change is going out, and say where the deploy pull request stands when the try ends. A work item the try merged waits at `deploy` until that pull request merges and the rollout runs, which is after the try with `root` paused. An issue it opens is an issue. Record each in the undo list under "Anything outward made for the run".
- **The line stays stopped after the try until the images merge and deploy.** Unmerged images may write events `main`'s line cannot read, or reads differently (a new event version it skips, a hold it does not clear), and a `main` line started on that store then sticks on the work item the try took, or carries it on wrongly. Whether this branch's events are ones `main` reads is not judged at the end of a try: the stop is the rule, whatever the change. Put the cluster back as the undo says, leave the line stopped, and tell Martin which work items the try moved and which seq each is at; he starts the line, from the console or `make start-the-line`, once the stack is deployed. If the try shows the change is wrong and it will not merge, say so: those events are then his to keep or clear, as a dry run's are.
- **One holder.** The session running the try holds the cluster, on the board, from the first `set image` to the last tick of the undo list; another session's work on the cluster waits. A try that must end in another session ends with the undo list, which is why it is written first.
- **Not for the app's images.** Nothing built on the Mac runs in `website`, `scoreboard` or `flagd`, live or dry: a change to the app is tried in its own repository and reaches the cluster through its pull request and its deploy.

## A stack of unmerged branches

A task of several pull requests is tried together, before review (the implement skill's Try before review), from branches with no pull request yet:

- **Build from the top branch**, which holds every branch below it: `factory` and `factory-runner` from its head, as above, in its worktree, never in the main checkout. Build `console` too if any branch in the stack changed it or adds a migration, since the `migrate` Job runs on the console's image and only it holds the migrations; run the `migrate` copy (step 7) on that image if any branch adds one: compare against every branch, not only the top one's own diff (`git diff origin/main...<top branch> --stat`). The manifests (step 8) and the alert rules (step 9) come from the top branch too, which holds every branch's.
- **A fault** goes back to the branch it belongs in, and the branches above take it by merges, bottom first. Build again from the top branch's new head, with a new tag (the tag is its short sha), point the deployments at it, and try again; `docker rmi` the tags each try leaves behind, or leave them for the undo list.
- **Undo** is the same as for one branch: the list at the end covers every image the try used, whichever branch it was built from.

## A fix tried on a work item held for it

An agent's step after a hold (a replan, say) is tried on the bench first, on a fixture of the same shape. What the bench cannot show (what the line folds from the work item's events, the commit it picks, the step it starts) is tried on the real work item held for it, as the fault was found on: set the take to it (`make take-the-line ONLY=<number>`), run the images that carry the fix, and have its hold answered. The line is in a dry run, so its events, with the dry run's made-up pull request, stay in that work item's history, which the live line acts on once `LINE_MODE` is back: try it there only when Martin has agreed to that for the run. That answer is Martin's, given in the console with his passkey: put it in the one sitting the try batches his part into, with what to answer and what to look for after, or answer it in the console signed in as him, when he has handed it to you for that run. Never write the answer to the store yourself. Then follow the step it starts, and record which work item it was and what the line did with it for the undo list. After the run, leave the line stopped until Martin has said what becomes of that work item's dry-run events.

## Stopping the line, and a cap

- **Stop the line** with a step in hand: `make stop-the-line REASON="..."`. Its Jobs should go at once, `runners` empty within a minute, and nothing count against the step; after `make start-the-line` it runs again as a new Job.
- **A release in flight** is aborted by the same command (with none, it says so): the stable version takes all the traffic within seconds, and the script prints the weights and the one command that retries the release. A release whose stable version has no pod ready to serve (the first after the app is reset, whose stable version admission never let run) is not aborted: the script says so and prints the full promotion and the abort to make by hand, and that first release stays at its first step until promoted fully. `make start-the-line` does not resume it: an aborted release stays aborted until it is retried, which is Martin's call, or a new deploy starts another. Stopping the line for a run therefore stops a real release of the app too, if one is going out: look first (`bin/k -n website get rollout website`), and tell Martin if you aborted one.
- **A provider's cap.** For the local model, `lms server stop` during a step, then `lms server start`. For Anthropic, Martin sets the Claude Console workspace's limit below its spend, and raises it again after; never change it yourself. The gateway appends `spend.capped` at the first refused call and probes every three minutes until it can append `spend.cleared`. The line should start no step behind the cap, count nothing against the step it ended, and run it again when the cap clears; the console says why meanwhile.

## Following a run

- `bin/watch <after-seq>` streams new events, Job changes and pod restarts, once a minute, for Claude Code's Monitor tool. `bin/poll <after-seq> [since]` is one look: events, `model_calls` by job (calls, minutes, prompt size, cache reuse, cost), the line table and runner Jobs.
- **`factory line soak-check`** from the host, as root `AGENTS.md` shows, with `kubectl proxy` and Postgres forwarded. Never by `kubectl exec` in the line pod: a second Node process there passes its memory limit and restarts the line. `--no-spend` after a run on Qwen.
- **A step's conversation.** In `record` mode the gateway keeps every call as a cassette on the `cassettes` volume, and the last call's request holds the conversation so far; `model_calls.cassette` is its hash. The gateway's image has no shell: start a short-lived pod on the `factory` image with the volume read-only at `/c`, `args: [-e, "setTimeout(()=>{}, 3600e3)"]` (the entrypoint is node), as user 65532 with a read-only root and no capabilities, then `bin/k -n factory exec -i <pod> -- /nodejs/bin/node - <hash prefix> < bin/trace.js`. Delete the pod after.
- **Runner Job names** are `<agent>-<work item>-<round>-<n>`, where `n` counts every step the work item has started, whichever agent.

## Putting it back

`bin/try end` does what follows for everything `try begin` changed, in this order, from its state file. What you changed by hand you put back by hand, as follows.

Order matters. Giving `root` its sync policy back restores images and the values `main` sets, but not env variables that `main` does not set, nor Martin's take, which is in the store: with `LINE_MODE` restored to `live`, the line would act in GitHub on the work item the try took. And a line in dry run takes the next ticket at once once a take allows it, which a live line then carries to its end, with the dry run's made-up issue. So first, in one `set env` on `line`, set `LINE_MODE=off`, which takes nothing, and remove every env the try added (`ALL_LOCAL`), and do the same for each other deployment (`github`'s dry-run delays, `gateway`'s and `console`'s `ALL_LOCAL`), waiting for each rollout (`bin/k -n factory rollout status deployment/<name>`): each `set env` makes a new ReplicaSet on the local image, admitted only while `factory-images` is still on Audit, so one still rolling out, or made after, when `root` puts it back to Deny is refused, and recorded on the Guardrails panel as if it were an attack. Then stop the line (`make stop-the-line REASON="putting a try back"`, which aborts a release in flight: look first, as [Stopping the line](#stopping-the-line-and-a-cap) says): once `root` sets `LINE_MODE` back to `live`, the line reopens every ticket the dry run verified ("the dry run's fix never shipped") and takes it again, in GitHub for real, so it stays stopped until Martin, told which work items those are, starts it. Then delete any runner Jobs left in `runners` (`bin/k -n runners delete jobs --all`), or wait until there are none, since `root` puts `factory-images` back to Deny before it moves the deployments off the local images, and a Job on one would be refused; then restore the sync policy, which sets `LINE_MODE` back and puts `factory-images` back as `main` says; then check each deployment's env against what you recorded, that `bin/k get imagevalidatingpolicy -o custom-columns=NAME:.metadata.name,ACTIONS:.spec.validationActions` shows the four policies as `main` sets them (all `[Deny]`), that no pod or Job in `factory` or `runners` still runs a local image (`bin/k -n factory get pods,jobs -o jsonpath='{..image}'`, and the same for `runners`, with nothing `local-` and none of the digest references made for the run: a pod admitted under Audit keeps running after Deny returns), that no red-team attack pod is left in `red-team` or `runners` (`bin/k -n red-team delete pods -l factory.mrogan.dev/red-team`, and the same in `runners`, where admission refuses a new one but an older image may have left one, as they are bare pods and not Jobs), that each manifest applied by hand is gone, or `main`'s again, that the `prometheus` Application is back on `main` (`bin/argocd-core app get prometheus`), and that `select work_item, stage from line` has nothing new. The node's digest references are not Argo CD's: remove each one made for the run.

Copy this into `scratch/` at the start:

```markdown
# To undo after <the run>

- [ ] `line`: `LINE_MODE=off`, and `ALL_LOCAL` and anything else added removed, in one `set env`, its rollout finished, before `root` gets its sync policy back; was: …
- [ ] Martin's take: back as it was before the try (`make take-the-line EVERY=1`, `NEXT=<n>` or `ONLY=<n>`), for Martin to confirm; was: …
- [ ] `gateway` env: remove `ALL_LOCAL`, rollout finished; was: …
- [ ] `console` env: remove `ALL_LOCAL`, rollout finished; was: …
- [ ] `github` env: remove `GITHUB_DRY_RUN_CHECKS_SECONDS`, `GITHUB_DRY_RUN_MERGE_SECONDS`, rollout finished; was: …
- [ ] The line stopped (`make stop-the-line`) before `root` sets `LINE_MODE` back, and the work items the dry run verified, which a live line reopens, listed for Martin: …
- [ ] `runners`: no Jobs left before `root` gets its sync policy back; no attack pods left in `red-team` or `runners` (`bin/k -n red-team delete pods -l factory.mrogan.dev/red-team`, and the same in `runners`).
- [ ] `factory-images`: back as `main` sets it, which `root`'s self-heal does, whether a launch of attack 5 left it on Deny or Audit; was: …
- [ ] No pod or Job in `factory` or `runners` on a `local-` image, or on a digest reference made for the run.
- [ ] `admin` and `red-team` env: remove anything added; was: …
- [ ] Argo CD `root`: `bin/argocd-core app set root --sync-policy automated --auto-prune --self-heal`, then check `line`, `gateway`, `github`, `console`, `admin` and `red-team` are back on `main`'s images (`line`'s and `red-team`'s container, `runner-image` and `RUNNER_IMAGE`), with `LINE_MODE` and `GITHUB_DRY_RUN` as `main` sets them, and no work item new on the line; was: …
- [ ] Manifests applied by hand: each one the branch added gone (`bin/k -n <namespace> get <kind> <name>` finds none, without `-n` for a cluster-scoped one), each one it changed `main`'s again; which, with its namespace: …
- [ ] The `prometheus` Application's values source back on `main` (`bin/argocd-core app get prometheus`), and its rules `main`'s; anything else the branch changed in its values: …
- [ ] Any copied `migrate` Job deleted (migrations stay applied).
- [ ] Digest references made on the node removed: `docker exec k3d-software-factory-server-0 ctr -n k8s.io images rm <repo>@<digest>` for each; which: …
- [ ] Local images removed: `docker rmi` each `local-*` tag.
- [ ] The line started (`make start-the-line`), so triage takes work again, only once Martin knows which work items it will reopen and has said so, and no held work item answered for the try waits on him. After a live try, not before the images have merged and deployed: `main`'s line cannot read what they wrote.
- [ ] After a live try: each work item it moved, with its seq, and each pull request, merge, deploy and issue it made in GitHub, listed for Martin; the cluster given back on the board.
- [ ] LM Studio's server running (`lms server status`).
- [ ] The Claude Console workspace's limit back where it was, if Martin lowered it.
- [ ] The bench's Postgres removed (`docker rm -f sf-bench-pg`), its Claude spend noted.
- [ ] Anything outward made for the run (a label, pull requests made to try a gate) listed for Martin.
- [ ] A held work item answered for the try: which, how, and what the line did with it, for Martin; the line stays stopped until he says what becomes of its dry-run events.
- [ ] The store: the dry run's events stay on the work items it took, with its made-up pull request and issue numbers. Say which, for Martin to keep or clear.
```
