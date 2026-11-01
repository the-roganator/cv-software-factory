# AGENTS.md

Software Factory: AI agents and deterministic gates that look after a live web app, built by Martin Rogan as a portfolio demo.

Read [`docs/INTENT.md`](docs/INTENT.md) first: why this exists and the bar everything is held to. Then [`docs/AGENTS.md`](docs/AGENTS.md), which signposts the specification and other docs.

Everything you write here is public and part of the demo. Write for a thoughtful reviewer.

## Working here

```sh
mise install && pnpm install   # the toolchain mise.lock holds, dependencies and git hooks
make check                     # what CI requires: lint, types, tests, design tokens, manifests
pnpm dev                       # the console on :5173 with the samples, reloading on change
make e2e                       # every browser test CI runs, live ones too, in the pinned Playwright image
make zap                       # ZAP's baseline scan of the console signed in as Martin, as CI runs it
make up / make samples / make status / make down
make enrol                     # a one-time code to enrol a passkey on the console
make share-key                 # the traffic generator's signing key, made once, and its public half for the app
make refusal-key               # the GitHub worker's key for signing its refusals, made once, and its public half for the line
make judgements-token          # triage's token for the gateway's judgements, made once (on an older cluster, before the deploy that needs it)
make guardrails                # every guardrail's proof but the attacks, recorded in the store, from a clean main (PROOFS="…" for some); the drill asks first
```

The cluster's console is at `https://console.localhost:8443`, and plain HTTP on its host redirects there: Safari drops a `Secure` cookie over HTTP, even on `localhost`, and passkeys need a secure context. The app's hosts (`website.localhost:8080` and the canary), Grafana and Argo CD stay on plain HTTP at :8080. `make up` makes a local certificate authority once, in `~/.config/software-factory/local-ca` (`scripts/local-ca.ts`), whose name constraints let it sign for `localhost` names only, has macOS trust it for TLS servers (it asks once), and gives Traefik the console's certificate, renewed in its last 30 days by any `make up`. Decline the prompt and the console still shows past a browser warning, but secure cookies and passkeys, which the admin sign-in needs, will not work there; the next `make up` asks again. `make untrust-ca` takes it out of the Keychain and deletes it; `make down` leaves it. A new cluster gets the :8443 port from `deploy/k3d/cluster.yaml`; to a cluster without it, `make up` adds it in place (`k3d cluster edit`, which makes only the load balancer again, so the store keeps its work items), and says so.

Martin signs in to the console with a passkey; there is no password. `make enrol` prints a one-time code, good for ten minutes and five tries, which the console's enrolment page (`https://console.localhost:8443/?view=enrol`) takes to make a passkey on that device; two may be held at once, and `make enrol REVOKE_OTHERS=1` revokes every passkey and ends every session first. Alerts reach his phone through Pushover: `make up` gives Alertmanager the Keychain's `pushover-app-token` and `pushover-user-key` (`make pushover-key` alone, after a change), and without them nothing reaches his phone and everything else works. On the local profile nothing reaches it either until he switches "Alerts to my phone" on in the console's Controls. A phone cannot use the local console, as its `localhost` is itself and a passkey belongs to its host: on the local profile the phone is Pushover, and the console's phone layout is tried at phone width on the Mac.

The inner loop runs on the host, not through GitOps. With the cluster up, forward its collector and Postgres; `pnpm dev` reads the event store instead of the samples when `PGHOST` is set:

```sh
kubectl --context k3d-software-factory -n telemetry port-forward svc/otel-collector 4318 &
kubectl --context k3d-software-factory -n factory port-forward svc/postgres 5432 &
```

- The workers can run on the host instead of in the cluster, against forwarded Prometheus, Loki, Tempo and Postgres, and a gateway that runs on the host too. The collector's address is the default (`localhost:4318`, forwarded as above), so the workers' own telemetry arrives as well:

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
  # Triage's token for judgements: one value, made here, for the gateway and triage on the host alike. Without it the
  # gateway answers every judgement 401, and triage will not start.
  export JUDGEMENTS_TOKEN="$(openssl rand -hex 32)"
  # The gateway, with the keys from the Keychain (leave one out to replay that provider only), on :8080. It reaches LM
  # Studio at 127.0.0.1:1234; ALL_LOCAL=true sends every agent there. Its cassettes hold whole prompts, reports and
  # tool output: keep them out of the repository (only eval cassettes, made from invented reports, are committed).
  (store_role gateway && GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/cassettes TYPESAFE_API_KEY="$(security find-generic-password -s typesafe-api-key -w)" \
    ANTHROPIC_API_KEY="$(security find-generic-password -s anthropic-api-key -w)" \
    node --import ./apps/factory/src/telemetry.ts apps/factory/src/cli.ts gateway) &
  (store_role triage && GATEWAY_URL=http://localhost:8080 ARTIFACTS_DIR=/tmp/artifacts node apps/factory/src/cli.ts triage)
  (store_role probes && APP_URL=http://website.localhost:8080 ARTIFACTS_DIR=/tmp/artifacts PORT=8090 node apps/factory/src/cli.ts probes run)
  ```

  The admin service runs on the host too, against the forwarded Postgres, for working on it. Its password is in `postgres-admin`, which `make up` makes and the migrate Job sets: on a cluster made before it, run `make up` and let Argo CD sync again. It serves `/admin/` on its own port, so a browser reaches it only through the console's origin, which is the one a passkey and `Origin` are checked against. `make enrol`, as above, makes the code for the store it reads:

  ```sh
  (store_role admin && ADMIN_ORIGIN=https://console.localhost:8443 GRAFANA_URL=http://grafana.localhost:8080 ARGOCD_URL=http://argocd.localhost:8080 \
    PORT=8093 node apps/factory/src/cli.ts admin)
  ```

  For the console's sign-in pages in `pnpm dev`, start it with `ADMIN_ORIGIN=http://localhost:5173` and run `ADMIN_URL=http://localhost:8093 pnpm dev`, which passes `/admin/` to it as Traefik does. That works in Chrome; Safari drops the `Secure` cookie over plain HTTP.

  The GitHub worker acts as the factory's App, with its key from the Keychain; `GITHUB_DRY_RUN=true` records what it would do in the artifact store and touches nothing in GitHub:

  ```sh
  GITHUB_APP_CLIENT_ID=Iv23liE1Dj3iYkwWX59z GITHUB_APP_PRIVATE_KEY="$(security find-generic-password -s factory-github-app-key -w | base64 -d)" \
    GITHUB_DRY_RUN=true ARTIFACTS_DIR=/tmp/artifacts PORT=8091 node apps/factory/src/cli.ts github run
  ```

  The GitHub worker signs each refusal it answers (its guard's, and GitHub's 403s) so the line can record it: `make refusal-key` (and so `make up`) makes its Ed25519 key once, through stdin, the Secret `refusal-signing-key` in `factory`, which only the worker reads, and its public half, the ConfigMap `refusal-key`, which the line reads. On the host, `REFUSAL_SIGNING_KEY` and `REFUSAL_PUBLIC_KEY` take them as PEM; without them the worker answers unsigned and the line records none. On a cluster made before it, run it once.

  Runners need the cluster: their agent pods reach the cluster's gateway and the line's handback, and nothing else. The smoke run asks the line, through a port-forward to its step API, to have a coder fix an off-by-one seeded in a scratch copy of the app; the GitHub worker records the commit it would have made, and nothing reaches GitHub. The coder works on Claude, through the cluster's gateway, and the run costs money; with `ALL_LOCAL=true` on that gateway and LM Studio running, it works on Qwen, for nothing:

  ```sh
  kubectl --context k3d-software-factory -n factory port-forward svc/line 8092:8080 & sleep 2
  curl -s localhost:8092/v1/smoke -H 'content-type: application/json' -d "{\"commit\":\"$(git ls-remote https://github.com/the-roganator/cv-worlds-worst-website.git main | cut -f1)\"}"
  ```

  The line itself (`factory line serve`) runs in the cluster only, for the same reason: its agent pods reach its handback there. `LINE_MODE` on its deployment turns it on, `dry-run` to have the GitHub worker record what it would do, and it is a deploy change like any other. The `factory` and `factory-runner` images move together. In `dry-run` the GitHub worker passes the checks on the commits it would have made and merges its pull requests after a while (`GITHUB_DRY_RUN_CHECKS_SECONDS`, `GITHUB_DRY_RUN_MERGE_SECONDS` on its deployment), so the line goes round. For a night on Qwen, set `ALL_LOCAL=true` on the gateway and the line, and on the console so its settings page says so, which sends every agent there whatever the console's settings say: the line gives a step on the local model longer. What the line takes is Martin's to set in the console's Controls, which the line reads each pass: Just one (its number), to take one work item end to end, one step at a time on the local model: the line takes that ticket onto it if it is not there, and leaves every other work item as it is; The next few (how many), to have the line choose for itself and stop after a few: it takes the oldest open ticket of the highest severity, as ever, until it has taken that many work items since he chose it, and carries them to their end; or Every ticket. `LINE_ONLY` (a work item's number) and `LINE_TAKE` (how many in all) on the line's deployment do the same for a line with no take set, a fresh store or one on the host, and apply no more once he sets one. The morning after, with Postgres forwarded as above and `kubectl proxy` running, `(store_role line && KUBE_API_URL=http://127.0.0.1:8001 node apps/factory/src/cli.ts line soak-check --since <when it started>)` says whether a lease is stuck, a runner left behind, an event not valid, or a work item spent more than the highest cap on one in force since then (Martin's setting, within `FACTORY_PROFILE`'s policy), with the total spent, and how the work items went round (`--json` for all of it). Add `--no-spend` after a night on Qwen, which must spend nothing at all.

  After the merge the line carries a work item through Release and Verify, with settings on its deployment, each set by the deploy pull request that pins the image reading it. `RELEASE_ROLLOUT` (`website/website`) turns on its read-only watch of the app's releases, which needs `PROMETHEUS_URL` (`http://query.telemetry:9090`, the read-only proxy's Prometheus port) too; unset, it records no release, and a merged work item waits at Release. Verify asks the probes (`PROBES_URL`, their verify port: `http://probes:8081`), Prometheus, Loki (`LOKI_URL`, `http://query.telemetry:3100`) and Tempo (`TEMPO_URL`, `http://query.telemetry:3200`), which only the agreement check reads: without it, wrong metrics wait; a sense with no address leaves its work items waiting at Verify, and after a day holding for Martin. The probes serve Verify on `VERIFY_PORT` (8081, on the host too) and take pictures of a canary only with `CANARY_URL` (`http://website-canary.website`) on their deployment. In `dry-run` the line releases and verifies the dry run's merges itself, `LINE_DRY_RUN_RELEASE_SECONDS` apart (60), each event marked `dryRun`, so a soak goes round past the merge; a dry run's merge waits at Release for it and is never held. With `LINE_ONLY`, the line still watches the app's releases, and records one that carries that work item or none; one that also carries another is left for the whole line.

  One agent's step also runs on the host, for working on its prompt, with no cluster but Postgres for its job token: the one forwarded above, or a throwaway container migrated by `packages/store/src/migrate.ts` with `LINE_PASSWORD` and `GATEWAY_PASSWORD` set, so the step and its gateway connect as their own roles there too. `factory line bench <agent> <fixture>` runs the runner's own prepare and agent steps on a fixture's invented work (`apps/factory/src/line/bench/fixtures.ts`), against a gateway on the host, and prints the handback, whether its result fits the agent's schema, how many of its calls the cassettes replayed, and how long it took; alone, it lists the fixtures. Work on Qwen, as here; then without `ALL_LOCAL` and with the Anthropic key, to record Claude's cassettes, which costs money; then with `GATEWAY_MODE=replay`, which replays a step in seconds up to its first changed call. Cassettes made from fixtures hold only invented work and the app's public code:

  ```sh
  # Against the cluster's Postgres, forwarded as above. The try-the-line skill runs the same against a throwaway store.
  (store_role gateway && ALL_LOCAL=true GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/bench-cassettes PORT=8180 node apps/factory/src/cli.ts gateway) &
  (store_role line && GATEWAY_URL=http://localhost:8180 node apps/factory/src/cli.ts line bench coder off-by-one)
  ```

  A runner's two steps also run as containers, for working on the runner itself: `docker build -f apps/runner/Dockerfile .`, then `runner prepare` and `runner agent` with the variables in `apps/runner/src/step.ts`.

  The traffic generator (`factory traffic`) runs on the host against the cluster's Traefik, which k3d serves on :8080, so a canary's split applies to it as to the cluster's copy. `--walk` finds the pages from the front door, as the generator does when it starts, prints the round it would walk, and sends nothing more. `INGRESS_URL` names the ingress to connect to when `APP_URL`'s host does not resolve, and the host is still sent. With no `SHARE_KEY_FILE` it signs no id, so none of its requests is in a flag's share: the signing key stays in the cluster. Aimed at a port-forward of the app's Service, it would reach the stable version only, and a canary would see none of it:

  ```sh
  APP_URL=http://website.localhost:8080 node apps/factory/src/cli.ts traffic --walk
  APP_URL=http://website.localhost:8080 node apps/factory/src/cli.ts traffic
  ```

  Beside the cluster's own generator, it would double the app's traffic and the requests a canary is judged on, so scale that one to nothing first (`kubectl -n factory scale deployment/traffic --replicas=0`), and back to one after.

  Scale the cluster's copy of a worker to nothing first (`kubectl -n factory scale deployment/triage --replicas=0`), and back to one after, so two do not take the same signals. Add `PAGES_URL=http://localhost:8090` to triage to have it read the pages reports name, and `PROMETHEUS_URL=http://localhost:9090 LOKI_URL=http://localhost:3100 TEMPO_URL=http://localhost:3200` to have it look at what each sense reads before it trusts a signal.
- Feature flags live in one `FeatureFlag`, `flags` in `flagd`, which flagd serves to the app ([feature flags](docs/COMPONENTS/FEATURE-FLAGS.md)). Git holds it with no flags, and Argo CD makes it and leaves its flags alone. Martin stages a flag in the console's Controls, and the admin service (`POST /admin/flags/<flag>/stage`, on the console's origin) writes it in the stages' shapes, with a new `flag-set-revision` on each write; `GET /admin/flags/held` says whether the app holds it. Read it with `kubectl --context k3d-software-factory -n flagd get featureflag flags -o yaml`. A flag written there by hand in any other shape is dropped, and so turned off, at the admin service's next write. Each stage is seen as its audience sees it: Preview at `http://website.localhost:8080/?preview=<flag>`, which keeps the preview cookie in that browser for a day; Checks only with the mark, which Traefik removes, so through a port-forward of the app's Service, as the probes reach it, where every marked answer names the revision of the flag set the app holds:

  ```sh
  kubectl --context k3d-software-factory -n website port-forward svc/website 8081:80 &
  curl -sI -H 'x-unmeasured: 1' localhost:8081/health | grep -i x-flags-revision
  ```

  Share is on only for the traffic generator's signed requests. `make share-key` (and so `make up`) makes its Ed25519 key pair once, through stdin and never a file on the Mac: the private key is the Secret `share-signing-key` in `factory`, which only the generator mounts, and the public key is the ConfigMap `share-key` in `website`, written again from the Secret each time, which admission lets only the local kubeconfig's user write. On a cluster made before it, run it once: until then the generator signs no id, and no flag at Share can be compared.
- Node 24 runs TypeScript directly: erasable syntax only, `.ts` extensions in imports, no build step. The console's browser code is the exception: Vite builds it.
- In the console, anything that runs every frame (a drag, a wipe, the reel settling) writes to the DOM through refs, and component state changes only when the movement ends. A test counts renders during a drag.
- Visual snapshots are taken in the pinned Playwright image, never on the host: `make e2e` refreshes them with `UPDATE=1`.
- Commits and pull request titles are Conventional Commits (`scripts/commit-msg.ts` checks both). Pull requests are squash-merged; nothing is pushed to `main`.
- Pull requests that build on each other's unmerged work go in a stack, which the merge queue and the review gate both handle (ADR 0014); independent work branches from `main`. Each branch is made from the one below and its pull request opened into it, then `gh stack link <bottom> … <top>` (their numbers; `gh extension install github/gh-stack`) links them. A change below reaches those above by merging each branch into the next, bottom first, never by a rebase or a force-push. Martin merges a stack whole (`gh stack merge <stack> --squash`). The same holds in the app's repository. The `implement` skill's [Stacks](.claude/skills/implement/SKILL.md#stacks) has the rest.
- `deploy/` is GitOps: Argo CD deploys what is on `main`, so a change there reaches the cluster only when it merges. A deploy change that needs a new image (a migration, a new setting) waits for the pull request that pins that image.
- Admission control (ADR 0010) admits only images `build.yml` signed on `main`, and the few third-party images it names by digest, in `factory`, `runners`, `website`, `scoreboard` and `flagd`. Every copy enforces: `factory-images` (`factory` and `runners`), `website-images` (`website`), `scoreboard-images` (`scoreboard`) and `flagd-images` (`flagd`, flagd's image by digest alone). To try an unmerged image on the local cluster, the `try-the-line` skill switches `factory-images` to audit for the run, and Argo CD puts it back when the skill gives `root` its sync policy back. `website-images`, `scoreboard-images` and `flagd-images` are never switched: nothing built on the Mac runs in `website`, or beside the answer key, ever. A change to the app is tried in its own repository, and reaches the cluster through its pull request and its deploy. `make admission-ready` says whether every image the guarded namespaces run or will start would be admitted, the canary analysis's journeys Job in `website` included.
- The scoreboard (`factory scoreboard`) runs in the cluster only, alone in `scoreboard`: the one reader of the answer key. `make up` gives it each entry's id and fingerprint from the private checkout (`PRIVATE_DIR`, by default `../cv-software-factory-private`), through stdin and never a file; with no checkout it has no key, publishes once that it is off, and the console says "Scoreboard off" beside the app's name. It reads the key when it starts: `make scoreboard-secrets` writes it again and restarts the scoreboard. On a cluster made before the scoreboard, run that before the deploy that brings it, whose migrations set its role's password. For the results, `--print` counts once and prints the four figures, false positives too, and never an id:

  ```sh
  kubectl --context k3d-software-factory -n scoreboard exec deploy/scoreboard -- /nodejs/bin/node src/cli.ts scoreboard --print
  ```
- Files listed in `.github/CODEOWNERS` are the rules of the line, and a change to one merges only with Martin's approval. When the work needs one changed, change it in the same pull request, keep to what the work needs, and give each file a line in a section of the description of its own: what changed and why. Never leave one stale, or file an issue for a change that belongs in the pull request.
- Merging is Martin's call. The factory's App opens the deploy and release pull requests; no workflow opens or approves one.
- The toolchain moves only when someone upgrades it: `mise upgrade`, which writes `mise.lock`, and both files in a `chore(toolchain)` pull request ([`CONTRIBUTING.md`](CONTRIBUTING.md#working-on-it) says how far each tool may move). Dependabot does not read mise.
- pnpm installs no release younger than a day, runs no dependency's install script unless `pnpm-workspace.yaml` allows it, and refuses a provenance downgrade. When it refuses, find out why; an exception goes in that file with its reason.
- Refresh a Dependabot pull request with `@dependabot rebase` or `@dependabot recreate`. Don't close it: that tells Dependabot to skip the version.
- A follow-up with no home yet is a [GitHub issue](https://github.com/the-roganator/cv-software-factory/issues) (`/issue` drafts one to the standard), on the milestone it waits for if it has one; never a code comment.
- Working notes that must never be committed (handovers, soak logs, drafts) go in `scratch/`. Git ignores it; `.ignore` keeps it searchable.
