# Workers and images

Where the gateway, the GitHub worker, triage, the intake, the log watcher, the line, the probes, the crawler and the traffic generator run. Part of the [factory plane](README.md#factory-plane).

- **v1:** one Deployment each in `factory` (`deploy/base/factory`), one replica.
- **Later:** Spaces or S3 for artifacts, a cloud secret store for the key.

What each may write:

| Store | Workers |
|---|---|
| The [event store](EVENT-STORE.md), each as its own role | The gateway, triage, the intake, the log watcher, the line, the probes and the crawler |
| The artifacts volume, which the console mounts read-only | Triage, the probes, the crawler, the GitHub worker for its dry runs, and the line for its runners' logs |
| The gateway's cassettes volume | The gateway alone |

The traffic generator writes to neither, and sends only its telemetry. The GitHub worker touches no store.

## Images

Three images, built by `build.yml`, signed there by digest with cosign's keyless signing as that workflow on main, each with an SBOM of each platform from Syft attested beside it. Each is pinned by digest per profile in a pull request the App opens (ADR 0005; [supply chain](SUPPLY-CHAIN.md)).

| Image | What it is | Runs |
|---|---|---|
| `factory` | Distroless Node | The gateway, the GitHub worker, triage, the intake, the log watcher, the line and the traffic generator |
| `factory-browser` | From the pinned Playwright image, running as an unprivileged user | The probes, the crawler and the canary's journeys |
| `factory-runner` | Node, git, this repository's pnpm (from `mise.lock`), the Agent SDK | The [runners'](AGENT-RUNNERS.md) Jobs; the line is given its pinned reference as `RUNNER_IMAGE` |

Chromium runs without its own sandbox, which the restricted Pod Security Standard refuses it, so the pod's other fences carry that.

## Secrets

- **The gateway's cassettes** are on a volume only it mounts, so recordings of real reports stay in the cluster.
- **The gateway's key.** `make up` creates its Secret from `TYPESAFE_API_KEY` or the Keychain, through stdin and no file. With none, the gateway replays only.
- **The GitHub worker's key.** `make up` creates its Secret from the Keychain's `factory-github-app-key` the same way. With none, that worker only reads public repositories, unauthenticated ([without a key](GITHUB-WORKER.md#without-a-key)).
- **The traffic generator's signing key.** `make share-key`, which `make up` runs, makes it once, in the cluster and nowhere else: an Ed25519 key in the Secret `share-signing-key`, which only the generator mounts, with its public half in the app's ConfigMap `share-key` ([feature flags](FEATURE-FLAGS.md#the-shares-signed-ids)). With none, the generator sends no id.
- **Triage's token for judgements.** `make judgements-token`, which `make up` runs, makes it once, in the cluster and nowhere else: 32 random bytes in the Secret `judgements-token`, which only triage and the gateway name, and triage needs to start; without it the gateway answers every judgement 401 ([the gateway](LLM-GATEWAY.md#judgements)).
