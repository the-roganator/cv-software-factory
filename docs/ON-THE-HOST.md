# On the host

How to run each part of the factory on the Mac, against the local cluster, for working on it. The inner loop runs on the host, not through GitOps. The cluster itself, its console and its state are [the local cluster](LOCAL-CLUSTER.md)'s.

A worker that takes work (triage, the probes, the red-team harness, the dependency sense, the traffic generator), run on the host, takes the place of the cluster's: each section below says how to scale the cluster's to nothing first, and back to one after, so two do not take the same work. The gateway and the admin service run beside the cluster's, on ports of their own. The GitHub worker is the exception: never run one on the host without `GITHUB_DRY_RUN=true` while the cluster's runs ([below](#the-github-worker)).

## The store and the collector

With the cluster up, forward its collector and Postgres; `pnpm dev` reads the event store instead of the samples when `PGHOST` is set:

```sh
kubectl --context k3d-software-factory -n telemetry port-forward svc/otel-collector 4318 &
kubectl --context k3d-software-factory -n factory port-forward svc/postgres 5432 &
```

## The workers and the gateway

The workers can run on the host instead of in the cluster, against forwarded Prometheus, Loki, Tempo and Postgres, and a gateway that runs on the host too. The collector's address is the default (`localhost:4318`, forwarded as above), so the workers' own telemetry arrives as well:

```sh
kubectl --context k3d-software-factory -n telemetry port-forward svc/prometheus-server 9090:80 &
kubectl --context k3d-software-factory -n telemetry port-forward svc/loki 3100 &
kubectl --context k3d-software-factory -n telemetry port-forward svc/tempo 3200 &
export PGHOST=127.0.0.1 PGDATABASE=factory
# Each worker connects as its own role (policy/store-grants.ts), with the password from its Secret, in a subshell of its own.
store_role() {
  export PGUSER="factory_$1" PGPASSWORD="$(kubectl --context k3d-software-factory -n factory get secret "postgres-$1" -o jsonpath='{.data.password}' | base64 -d)"
  [ -n "$PGPASSWORD" ] || { echo "no password for $1: run make worker-secrets" >&2; return 1; }
}
# Triage's token for judgements, the cluster's (make judgements-token), so the gateway and triage get the same value in
# any terminal. Without it the gateway answers every judgement 401, and triage will not start.
export JUDGEMENTS_TOKEN="$(kubectl --context k3d-software-factory -n factory get secret judgements-token -o jsonpath='{.data.token}' | base64 -d)"
# The gateway, with the keys from the Keychain (leave one out to replay that provider only), on :8080. It reaches LM
# Studio at 127.0.0.1:1234; ALL_LOCAL=true sends every agent there. Its cassettes hold whole prompts, reports and
# tool output: keep them out of the repository (only eval cassettes, made from invented reports, are committed).
(store_role gateway && GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/cassettes TYPESAFE_API_KEY="$(security find-generic-password -s typesafe-api-key -w)" \
  ANTHROPIC_API_KEY="$(security find-generic-password -s anthropic-api-key -w)" \
  node --import ./apps/factory/src/telemetry.ts apps/factory/src/cli.ts gateway) &
(store_role triage && GATEWAY_URL=http://localhost:8080 ARTIFACTS_DIR=/tmp/artifacts node apps/factory/src/cli.ts triage)
(store_role probes && APP_URL=http://website.localhost:8080 ARTIFACTS_DIR=/tmp/artifacts PORT=8090 node apps/factory/src/cli.ts probes run)
```

Scale the cluster's copy of a worker to nothing first (`kubectl --context k3d-software-factory -n factory scale deployment/triage --replicas=0`, and `deployment/probes` for the probes, which sense and signal as the cluster's do), and back to one after, so two do not take or send the same signals. Add `PAGES_URL=http://localhost:8090` to triage to have it read the pages reports name, and `PROMETHEUS_URL=http://localhost:9090 LOKI_URL=http://localhost:3100 TEMPO_URL=http://localhost:3200` to have it look at what each sense reads before it trusts a signal.

## The admin service

The admin service runs on the host too, against the forwarded Postgres, for working on it. Its password is in `postgres-admin`, which `make up` makes and the migrate Job sets. It serves `/admin/` on its own port, so a browser reaches it only through the console's origin, which is the one a passkey and `Origin` are checked against. `make enrol` makes the code for the store it reads ([signing in](LOCAL-CLUSTER.md#signing-in-and-alerts-to-the-phone)):

```sh
(store_role admin && ADMIN_ORIGIN=https://console.localhost:8443 GRAFANA_URL=http://grafana.localhost:8080 ARGOCD_URL=http://argocd.localhost:8080 \
  PORT=8093 node apps/factory/src/cli.ts admin)
```

For the console's sign-in pages in `pnpm dev`, start it with `ADMIN_ORIGIN=http://localhost:5173` and run `ADMIN_URL=http://localhost:8093 pnpm dev`, which passes `/admin/` to it as Traefik does. That works in Chrome; Safari drops the `Secure` cookie over plain HTTP.

## The GitHub worker

The GitHub worker acts as the factory's App, with its key from the Keychain; `GITHUB_DRY_RUN=true` records what it would do in the artifact store and touches nothing in GitHub:

```sh
GITHUB_APP_CLIENT_ID=Iv23liE1Dj3iYkwWX59z GITHUB_APP_PRIVATE_KEY="$(security find-generic-password -s factory-github-app-key -w | base64 -d)" \
  GITHUB_DRY_RUN=true ARTIFACTS_DIR=/tmp/artifacts PORT=8091 node apps/factory/src/cli.ts github run
```

Never run one on the host without `GITHUB_DRY_RUN=true` while the cluster's runs: each worker writes its own commit to the deploy and pin watches' branches whenever they are at any other ([ADR 0017](architecture/adr/0017-the-worker-queues-the-local-deploy-pins.md)), so two that write never settle, and neither queues anything.

The GitHub worker signs each refusal it answers (its guard's, and GitHub's 403s) so the line can record it: `make refusal-key` (and so `make up`) makes its Ed25519 key once, through stdin, the Secret `refusal-signing-key` in `factory`, which only the worker reads, and its public half, the ConfigMap `refusal-key`, which the line reads, and the console, to check each relayed refusal Guardrails shows. On the host, `REFUSAL_SIGNING_KEY` and `REFUSAL_PUBLIC_KEY` take them as PEM; without them the worker answers unsigned and the line records none.

## The red-team harness

The red-team harness (`factory red-team`) makes each of spec 5.3's attacks Martin launches ([its page](COMPONENTS/RED-TEAM-HARNESS.md)). It connects as its own role, `factory_redteam` (`make up` makes `postgres-redteam`), and acts only on an `attack.launched` of Martin's. It makes the egress and image attacks' pods in `red-team`, a namespace of their own, so it needs the Kubernetes API (`kubectl proxy`, as the line's `soak-check` uses it); attack 1 posts a report through the app's front door (`APP_URL`, `INGRESS_URL`); attacks 2 and 3 ask the GitHub worker's attack door (`GITHUB_ATTACK_URL`, the worker's `ATTACK_PORT`). Scale the cluster's copy to nothing first (`kubectl --context k3d-software-factory -n factory scale deployment/red-team --replicas=0`), and back to one after, so two do not take the same launch:

```sh
kubectl --context k3d-software-factory proxy --port=8001 &
kubectl --context k3d-software-factory -n factory port-forward svc/github 8082:8082 &
(store_role redteam && KUBE_API_URL=http://127.0.0.1:8001 ARTIFACTS_DIR=/tmp/artifacts \
  APP_URL=http://website.localhost:8080 RUNNER_IMAGE="$(kubectl --context k3d-software-factory -n factory get deploy red-team -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUNNER_IMAGE")].value}')" \
  GITHUB_ATTACK_URL=http://localhost:8082 node apps/factory/src/cli.ts red-team)
```

## The dependency sense

The dependency sense (`factory patching`, [its page](COMPONENTS/PATCHING.md#the-dependency-sense)) connects as its own role, `factory_patching` (`make up` makes `postgres-patching`), lists the cluster's pods through the Kubernetes API, and asks the GitHub worker's door for its two reads (`GITHUB_URL`, the worker's `PATCHING_PORT`). `--once` makes one pass and says what it appended, or why not. Give it the Deployment's `PATCHING_NAMESPACES`: unset, it lists every namespace, `runners` and its job tokens included. Scale the cluster's copy to nothing first (`kubectl --context k3d-software-factory -n factory scale deployment/patching --replicas=0`), and back to one after:

```sh
kubectl --context k3d-software-factory proxy --port=8001 &
kubectl --context k3d-software-factory -n factory port-forward svc/github 8083:8083 &
(store_role patching && KUBE_API_URL=http://127.0.0.1:8001 GITHUB_URL=http://localhost:8083 \
  PATCHING_NAMESPACES="$(kubectl --context k3d-software-factory -n factory get deploy patching -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PATCHING_NAMESPACES")].value}')" \
  node apps/factory/src/cli.ts patching --once)
```

## Runners and the smoke run

Runners need the cluster, with the line started: their agent pods reach the cluster's gateway and the line's handback, and nothing else. The smoke run asks the line, through a port-forward to its step API, to have a coder fix an off-by-one seeded in a scratch copy of the app; the GitHub worker records the commit it would have made, and nothing reaches GitHub. The coder works on Claude, through the cluster's gateway, and the run costs money; with `ALL_LOCAL=true` on that gateway and LM Studio running, it works on Qwen, for nothing:

```sh
kubectl --context k3d-software-factory -n factory port-forward svc/line 8092:8080 & sleep 2
curl -s localhost:8092/v1/smoke -H 'content-type: application/json' -d "{\"commit\":\"$(git ls-remote https://github.com/the-roganator/cv-worlds-worst-website.git main | cut -f1)\"}"
```

A runner's two steps also run as containers, for working on the runner itself: `docker build -f apps/runner/Dockerfile .`, then `runner prepare` and `runner agent` with the variables in `apps/runner/src/step.ts`.

## The line

The line itself (`factory line serve`) runs in the cluster only, for the same reason: its agent pods reach its handback there. `LINE_MODE` on its deployment turns it on, `dry-run` to have the GitHub worker record what it would do, and it is a deploy change like any other. The `factory` and `factory-runner` images move together. In `dry-run` the GitHub worker passes the checks on the commits it would have made and merges its pull requests after a while (`GITHUB_DRY_RUN_CHECKS_SECONDS`, `GITHUB_DRY_RUN_MERGE_SECONDS` on its deployment), so the line goes round. For a night on Qwen, set `ALL_LOCAL=true` on the gateway and the line, and on the console so its settings page says so, which sends every agent there whatever the console's settings say: the line gives a step on the local model longer.

A new store's line has not started, and nothing moves (no ticket taken, no model called, triage too) until Martin starts it, in the console's header or with `make start-the-line`. What the line takes is Martin's to set in the console's Controls, or with `make take-the-line` (`ONLY=<work item>`, `NEXT=<how many>` or `EVERY=1`, from his command line's role, with no passkey), which the line reads each pass:

- **Just one** (its number), to take one work item end to end, one step at a time on the local model: the line takes that ticket onto it if it is not there, and leaves every other work item as it is.
- **The next few** (how many), to have the line choose for itself and stop after a few: it takes the oldest open ticket of the highest severity, as ever, until it has taken that many work items since he chose it (not counting a ticket that closed on the look as it was taken), and carries them to their end.
- **Every ticket**, which the line takes while none is set.

The morning after, with Postgres forwarded as above and `kubectl --context k3d-software-factory proxy --port=8001` running, `(store_role line && KUBE_API_URL=http://127.0.0.1:8001 node apps/factory/src/cli.ts line soak-check --since <when it started>)` says whether a lease is stuck, a runner left behind, an event not valid, or a work item spent more than the highest cap on one in force since then (Martin's setting, within `FACTORY_PROFILE`'s policy), with the total spent, and how the work items went round (`--json` for all of it). Add `--no-spend` after a night on Qwen, which must spend nothing at all. `make close-work-item ONLY=<work item> REASON="…"` closes a work item the line has not taken, by the same command-line role: a ticket a try's invented report opened, or one he is done with before the line takes it; one the line has is closed in the console, so its issue goes with it.

After the merge the line carries a work item through Release and Verify, with settings on its deployment, each set by the deploy pull request that pins the image reading it. `RELEASE_ROLLOUT` (`website/website`) turns on its read-only watch of the app's releases, which needs `PROMETHEUS_URL` (`http://query.telemetry:9090`, the read-only proxy's Prometheus port) too; unset, it records no release, and a merged work item waits at Release. Verify asks the probes (`PROBES_URL`, their verify port: `http://probes:8081`), Prometheus, Loki (`LOKI_URL`, `http://query.telemetry:3100`) and Tempo (`TEMPO_URL`, `http://query.telemetry:3200`), which only the agreement check reads: without it, wrong metrics wait; a sense with no address leaves its work items waiting at Verify, and after a day holding for Martin. The probes serve Verify on `VERIFY_PORT` (8081, on the host too) and take pictures of a canary only with `CANARY_URL` (`http://website-canary.website`) on their deployment. In `dry-run` the line releases and verifies the dry run's merges itself, `LINE_DRY_RUN_RELEASE_SECONDS` apart (60), each event marked `dryRun`, so a soak goes round past the merge; a dry run's merge waits at Release for it and is never held. With Just one, the line still watches the app's releases, and records one that carries that work item or none; one that also carries another is left for the whole line.

## The bench

One agent's step also runs on the host, for working on its prompt, with no cluster but Postgres for its job token: the one forwarded above, or a throwaway container migrated by `packages/store/src/migrate.ts` with `LINE_PASSWORD` and `GATEWAY_PASSWORD` set, so the step and its gateway connect as their own roles there too, and with the line started there, as the gateway answers no agent on a line that has not started (the `try-the-line` skill says how). `factory line bench <agent> <fixture>` runs the runner's own prepare and agent steps on a fixture's invented work (`apps/factory/src/line/bench/fixtures.ts`), against a gateway on the host, and prints the handback, whether its result fits the agent's schema, how many of its calls the cassettes replayed, and how long it took; alone, it lists the fixtures. Work on Qwen, as here; then without `ALL_LOCAL` and with the Anthropic key, to record Claude's cassettes, which costs money; then with `GATEWAY_MODE=replay`, which replays a step in seconds up to its first changed call. Cassettes made from fixtures hold only invented work and the app's public code:

```sh
# Against the cluster's Postgres, forwarded as above. The try-the-line skill runs the same against a throwaway store.
(store_role gateway && ALL_LOCAL=true GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/bench-cassettes PORT=8180 node apps/factory/src/cli.ts gateway) &
(store_role line && GATEWAY_URL=http://localhost:8180 node apps/factory/src/cli.ts line bench coder off-by-one)
```

## The traffic generator

The traffic generator (`factory traffic`) runs on the host against the cluster's Traefik, which k3d serves on :8080, so a canary's split applies to it as to the cluster's copy. `--walk` finds the pages from the front door, as the generator does when it starts, prints the round it would walk, and sends nothing more. `INGRESS_URL` names the ingress to connect to when `APP_URL`'s host does not resolve, and the host is still sent. With no `SHARE_KEY_FILE` it signs no id, so none of its requests is in a flag's share: the signing key stays in the cluster. Aimed at a port-forward of the app's Service, it would reach the stable version only, and a canary would see none of it:

```sh
APP_URL=http://website.localhost:8080 node apps/factory/src/cli.ts traffic --walk
APP_URL=http://website.localhost:8080 node apps/factory/src/cli.ts traffic
```

Beside the cluster's own generator, it would double the app's traffic and the requests a canary is judged on, so scale that one to nothing first (`kubectl --context k3d-software-factory -n factory scale deployment/traffic --replicas=0`), and back to one after.

## Feature flags

Feature flags live in one `FeatureFlag`, `flags` in `flagd`, which flagd serves to the app ([feature flags](COMPONENTS/FEATURE-FLAGS.md)). Git holds it with no flags, and Argo CD makes it and leaves its flags alone. Martin stages a flag in the console's Flags panel, and the admin service (`POST /admin/flags/<flag>/stage`, on the console's origin) writes it in the stages' shapes, with a new `flag-set-revision` on each write; `GET /admin/flags/held` says whether the app holds it. Read it with `kubectl --context k3d-software-factory -n flagd get featureflag flags -o yaml`. A flag written there by hand in any other shape is dropped, and so turned off, at the admin service's next write. Each stage is seen as its audience sees it: Preview at `http://website.localhost:8080/?preview=<flag>`, which keeps the preview cookie in that browser for a day; Checks only with the mark, which Traefik removes, so through a port-forward of the app's Service, as the probes reach it, where every marked answer names the revision of the flag set the app holds:

```sh
kubectl --context k3d-software-factory -n website port-forward svc/website 8081:80 &
curl -sI -H 'x-unmeasured: 1' localhost:8081/health | grep -i x-flags-revision
```

Share is on only for the traffic generator's signed requests. `make share-key` (and so `make up`) makes its Ed25519 key pair once, through stdin and never a file on the Mac: the private key is the Secret `share-signing-key` in `factory`, which only the generator mounts, and the public key is the ConfigMap `share-key` in `website`, written again from the Secret each time, which admission lets only the local kubeconfig's user write. Until it is made, the generator signs no id, and no flag at Share can be compared.
