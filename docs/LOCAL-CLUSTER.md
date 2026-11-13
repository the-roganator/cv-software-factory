# The local cluster

The k3d cluster on Martin's Mac that `make up` makes and Argo CD deploys from `main`: its console's certificate, where its state lives, how it moves to a new k3s, how Martin signs in and hears of it, and the scoreboard's answer key. Running a part of the factory on the host, beside it, is [on the host](ON-THE-HOST.md)'s.

## The console's certificate and ports

The cluster's console is at `https://console.localhost:8443`, and plain HTTP on its host redirects there: Safari drops a `Secure` cookie over HTTP, even on `localhost`, and passkeys need a secure context. The app's hosts (`website.localhost:8080` and the canary), Grafana and Argo CD stay on plain HTTP at :8080. `make up` makes a local certificate authority once, in `~/.config/software-factory/local-ca` (`scripts/local-ca.ts`), whose name constraints let it sign for `localhost` names only, has macOS trust it for TLS servers (it asks once), and gives Traefik the console's certificate, renewed in its last 30 days by any `make up`. Decline the prompt and the console still shows past a browser warning, but secure cookies and passkeys, which the admin sign-in needs, will not work there; the next `make up` asks again. `make untrust-ca` takes it out of the Keychain and deletes it; `make down` leaves it.

Every port the cluster publishes (`deploy/k3d/cluster.yaml`) is on `127.0.0.1` alone, its Kubernetes API too, at `127.0.0.1:6550`, which the kubeconfig k3d writes names. A new cluster needs :6550 free on the Mac (`lsof -nP -iTCP:6550 -sTCP:LISTEN` shows what holds it), as it needs :8080 and :8443.

## Its state, and a new k3s

The cluster's state lives off its node, as on a managed cluster: k3s's data directory (its datastore, with every Secret and the feature flags, its certificates, and the local-path volumes, with the event store, the artifacts and the telemetry's history) is the Docker volume `k3d-software-factory-state`, which `make up` makes before the cluster and k3d does not delete with it; `make down` deletes it.

k3d cannot change a node's image, so `make upgrade-cluster` (`scripts/upgrade-cluster.sh`) moves the cluster to the k3s `deploy/k3d/cluster.yaml` pins as k3s upgrades itself: it stops the node and starts the new k3s on the same directory with the same token. Run it with the line stopped, which it checks. It copies the directory first, without the node's image cache, which the new k3s pulls again (an image imported with `k3d image import` goes), to a Docker volume beside it that never becomes a file on the Mac, and takes the figures `scripts/cluster-figures.ts` names: the events to the last seq, Martin's passkeys, sessions and the line's places, the flags, the Secrets in `factory` and the volumes' claims, as counts and digests. It calls the move done only when the new cluster's figures match, and deletes the copy then, unless `KEEP=1`; otherwise it keeps it, and `make upgrade-cluster BACK=1` goes back to it on the k3s it was made on, keeping what it replaces in a volume of its own. Each move takes a few minutes, most of them pulling images. A k3s move the scan finds is in the `cluster` lane, Martin's to apply with this command ([patching](COMPONENTS/PATCHING.md)).

## Signing in, and alerts to the phone

Martin signs in to the console with a passkey; there is no password. `make enrol` prints a one-time code, good for ten minutes and five tries, which the console's enrolment page (`https://console.localhost:8443/?view=enrol`) takes to make a passkey on that device; two may be held at once, and `make enrol REVOKE_OTHERS=1` revokes every passkey and ends every session first.

Alerts reach his phone through Pushover: `make up` gives Alertmanager the Keychain's `pushover-app-token` and `pushover-user-key` (`make pushover-key` alone, after a change), and without them nothing reaches his phone and everything else works. On the local profile nothing reaches it either until he switches "Alerts to your phone (Pushover)" on in the console's Controls. A phone cannot use the local console, as its `localhost` is itself and a passkey belongs to its host: on the local profile the phone is Pushover, and the console's phone layout is tried at phone width on the Mac.

## The scoreboard's answer key

The scoreboard (`factory scoreboard`) runs in the cluster only, alone in `scoreboard`: the one reader of the answer key ([its page](COMPONENTS/SCOREBOARD.md)). `make up` gives it each entry's id and fingerprint from the private checkout (`PRIVATE_DIR`, by default `../cv-software-factory-private`), through stdin and never a file; with no checkout it has no key, publishes once that it is off, and the console says "Scoreboard off" beside the app's name. It reads the key when it starts: `make scoreboard-secrets` writes it again and restarts the scoreboard. For the results, `--print` counts once and prints the four figures, false positives too, and never an id:

```sh
kubectl --context k3d-software-factory -n scoreboard exec deploy/scoreboard -- /nodejs/bin/node src/cli.ts scoreboard --print
```
