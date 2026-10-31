# Admission control

Refuses unsigned images. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** Kyverno 1.19 (ADR 0010), installed by Argo CD from its chart at a pinned version, its images by digest, before anything it guards.

## The policy

One `ImageValidatingPolicy` (`deploy/base/admission/images`), in four copies, each admitting only the images its namespaces run:

| Copy | Namespaces | Admits |
|---|---|---|
| `factory-images` | `factory`, `runners` | The factory's images, Postgres and its exporter |
| `website-images` | `website` | The app's image, and the factory's browser for the canary's analysis |
| `scoreboard-images` | `scoreboard` | The factory's own image, which the [scoreboard](SCOREBOARD.md) runs |
| `flagd-images` | `flagd` | [flagd](FEATURE-FLAGS.md)'s image, by digest, and none of ours |

A pod's images, its init and debug containers' and its image volumes' included, must be by digest, and either:

- **ours on GHCR,** from a repository its copy admits, signed keyless by `build.yml` on `main` of the repository that builds them (the identity compared whole; [supply chain](SUPPLY-CHAIN.md)); or
- **named by digest in the policy, with a reason** (Postgres and its exporter, in `factory`; flagd, in `flagd`).

It checks the signature, not the SBOM: the deploy pull requests' checks verify that, where parsing it is cheap.

## Behaviour

- **A refusal** names the policy, the check and the images. The line records each of Kyverno's as `action.refused` (`admission-control`), from the Events it leaves: Kyverno's own in `default` for a request it blocked, or a controller's `FailedCreate` for a pod it could not make ([the line](ORCHESTRATOR.md#refusals-it-records-for-others)). The ValidatingAdmissionPolicies below leave no Event, and are not recorded.
- **It fails closed.**
- **Outside it:** Kyverno's namespace, Argo CD's and the system's. Telemetry's, the pod log collector's and Argo Rollouts' are not guarded, since they run only upstream charts.
- **Every copy enforces.**
- **Its verdicts are cached in memory,** so after a restart it verifies everything again.

## Reaching out

Its admission controller alone may leave the cluster, for GHCR and Sigstore's TUF repository: the internet on 443 outside private addresses, the nearest a NetworkPolicy gets to naming them (#176; [network policies](NETWORK-POLICIES.md#kyverno)).

## Memory

It has a 1 Gi memory limit. cosign's bundle discovery fetches and parses every bundle attached to an image, attestations included, and `factory-browser`'s SBOM attestations are about 23 MB per platform.

## Trying unmerged images

- The `try-the-line` skill switches `factory-images` to audit for a run on images built on the Mac. Audit reports what it would refuse (`kubectl get policyreports -A`), and admits it.
- `website-images`, `scoreboard-images` and `flagd-images` are never switched.

## The admin service's hold on the Rollout

The [admin service](ADMIN-SERVICE.md#the-canarys-controls) may get and patch the app's Rollout and its status, by name, for Martin's controls of the canary. A Role names objects, not fields, so `website-rollout-controls` (`deploy/base/admission/website/rollout-controls.yaml`) holds each of its requests to the fields those controls set:

- `spec.paused`, to pause and resume;
- `status.abort`, set or cleared, to abort and retry;
- `status.currentStepIndex`, forward only and no further than past the last step, with `status.pauseConditions` and `status.controllerPause` cleared, never set, to promote to the next step's weight;
- `status.promoteFull`, set, to promote fully.

Everything else in the spec and the status, and the Rollout's labels, annotations, finalizers and owners, must be as they were, and nothing may be made or deleted, so nothing the admin service does can change the image, the steps, the analysis or the routing. Within those fields the service holds itself: the Rollout's status does not tell a rollback from an abort, so the policy admits `status.abort` cleared after either, and the service retries either, judged afresh by the analysis; it alone refuses a step's promotion, a pause or a resume of a canary paused for Martin. It is a ValidatingAdmissionPolicy, Kubernetes's own, rather than Kyverno's: the API server evaluates it in process, so it holds whether or not Kyverno is up. It matches the admin service's service account alone (`system:serviceaccount:factory:admin`), denies, and fails closed. Argo Rollouts' controller, Argo CD and the line are not held by it.

## `flags`

`flags` in `flagd` holds the state of every [feature flag](FEATURE-FLAGS.md). flagd's watch lists the whole namespace, so its Role may read every FeatureFlag there, and flagd keeps serving the last flags it read when its resource goes. So `flagd-flags` (`deploy/base/admission/flagd/flags.yaml`) refuses any FeatureFlag in `flagd` but `flags`, and refuses the deletion of `flags`, but as its namespace is deleted, which takes flagd with it: off is a change to a flag, never a deletion. It holds every request, Argo CD's and an administrator's included. Like the hold on the Rollout, it is a ValidatingAdmissionPolicy, which holds whether or not Kyverno is up; it denies, and fails closed.

## The admin service's hold on `flags`

The admin service writes Martin's [stages](FEATURE-FLAGS.md#the-stages) into `flags`: its Role in `flagd` may get and update `flags`, by name. A Role names objects, not fields, so `flagd-flag-stages` (`deploy/base/admission/flagd/flag-stages.yaml`) holds each of its changes to the stages' shapes, which `policy/flags.ts` renders:

- every flag but the revision is a feature, named in lower-case letters and digits in words joined by hyphens, in one of the five shapes: off, checks, preview, a share of 10, 25 or 50, or everyone. Its whole definition is compared with the shape, so it has no other key, variant, value, state or variable of the request;
- `flag-set-revision` is there, with one string variant, `revision`, its default, of visible ASCII of 1 to 128 characters, and not `none`, `stale` or `invalid`;
- the rest of `flags` is as it was: the flag set's `$evaluators` and metadata, and its labels, annotations, finalizers and owners; and nothing may be made or deleted.

Which stage may follow which is the service's to hold. It is a ValidatingAdmissionPolicy, which holds whether or not Kyverno is up. It matches the admin service's service account alone, denies, and fails closed; Argo CD and an administrator are not held by it, and `flagd-flags` holds everyone.

## The mark

The factory's own checks send `x-unmeasured` (`UNMEASURED`, `senses/http.ts`), and a [feature flag](FEATURE-FLAGS.md)'s first stage is on for the requests that carry it. So does the admin service, which asks each of the app's pods for `/health` with it, for the revision of the flags it holds and nothing else, since the app tells only a marked request ([admin service](ADMIN-SERVICE.md#whether-the-app-holds-the-flags)). The network keeps visitors from sending it: the app's route through Traefik passes every request through the app's Middleware `visitors`, which removes it, and only the pods its [network policy](NETWORK-POLICIES.md#website) names reach the app any other way. That route and that Middleware are in the app's repository, which agents write, so `website-mark` (`deploy/base/admission/website/mark.yaml`) holds what that repository may make in `website`:

- **An `IngressRoute`:** each route's middlewares are `visitors` alone, in `website`, since a second one after it could set the header again. Its services carry no middlewares of their own, and name nothing in another namespace or provider (`name@provider`: `api@internal` would serve Traefik's own API on the app's host).
- **A `TraefikService`:** a weighted split alone, as the canary's is, held to the same rule for each service it shares out.
- **A `Middleware`:** the strip and nothing else, `headers` with `customRequestHeaders` removing `x-unmeasured` (an empty value removes a header). It is an allow-list, not a list of what is refused, because at Traefik 3.7 several kinds could put the header back: `headers` sets any request header, in any casing of its name; `forwardAuth` copies headers from an auth server's answer (`authResponseHeaders`, `authResponseHeadersRegex`); `basicAuth` and `digestAuth` write the user to a header they name (`headerField`); `chain` runs others; and `plugin` runs anything.

Traefik itself refuses a reference to an object in another namespace, so a route in `website` cannot name another namespace's Middleware or Service, and a route elsewhere cannot name the app's. An address is no such reference (a `forwardAuth` elsewhere could name the app's Service by URL), but only this repository makes Middlewares outside `website`. k3s's bundled chart leaves `providers.kubernetescrd.allowCrossNamespace` and `allowExternalNameServices` off, and nothing here changes its values: no `HelmChartConfig`, and no k3s argument in `deploy/k3d/cluster.yaml`. The app's project admits no other kind Traefik routes by: no `Ingress`, no `IngressRouteTCP`, no Gateway API route. The policy holds every request, Argo CD's and Argo Rollouts' among them, and fails closed. It is Kyverno's, as `website-routes` is, so it compares a Middleware's whole spec with the strip.

## `share-key`

`share-key` in `website` holds the traffic generator's public key, with which the app checks the ids of a [feature flag](FEATURE-FLAGS.md#the-shares-signed-ids)'s share. The app's repository, which agents write, may make ConfigMaps in `website`, and one of its own named `share-key` would let the app's code sign ids for itself. So `website-share-key` (`deploy/base/admission/website/share-key.yaml`) refuses anyone but `make share-key`'s user, `system:admin`, the cluster's administrator that the local kubeconfig names, to make, change or delete it: not Argo CD, for either repository, not another member of `system:masters`, and no service account. It lets through the deletion of the namespace's contents as the namespace itself is deleted, and holds no other ConfigMap. It is a ValidatingAdmissionPolicy, which holds whether or not Kyverno is up; it denies, and fails closed.

## `refusal-key`

`refusal-key` in `factory` holds the GitHub worker's public key, with which the line checks each refusal the worker signs before it records it ([the GitHub worker's refusals](GITHUB-WORKER.md#its-refusals-signed)). A key of anyone else's choosing would let whoever holds its private half put refusals the worker never made on the record, signed and verified. So `factory-refusal-key` (`deploy/base/admission/factory/refusal-key.yaml`) holds it as `website-share-key` holds `share-key`: only `make refusal-key`'s user, `system:admin`, may make, change or delete it, and the namespace's own deletion may take it. It holds no other ConfigMap, and is in no manifest, so Argo CD never writes it. `refusal-fences.test.ts` fails if it grows.

## Checks

- `make admission-ready` says whether every image the guarded namespaces run or will start would be admitted.
- `scripts/admission-refusals.sh` asks the cluster, in each guarded namespace, to start a pod on an image of ours that is unsigned, one signed by an identity other than `build.yml` on main, and one of ours the namespace does not run, each a server-side dry run, and keeps Kyverno's refusals in `deploy/test/admission-refusals.json`, which `admission.test.ts` reads. The image signed by someone else is the arm64 manifest from inside a build of the factory (in `website`, of its browser), which `build.yml` did not sign, signed keyless by `.github/workflows/other-identity.yml` on the branch `refusal/other-identity`, which is kept and never merged. So it is ours, in a repository the namespace runs, and refused for its signature alone. Before it asks, the script reads who signed each image (`scripts/signed-by.ts`, as the deploy watch reads it) and keeps that beside each refusal.
- `scripts/rollout-refusals.sh` asks the cluster, as the admin service's account, for the controls' patches and for the changes the policy and the Role must refuse, each a server-side dry run, and keeps the answers in `deploy/test/rollout-refusals.json`, which `release-fences.test.ts` reads.
- `release-fences.test.ts` fails if the Role or the policy grows.
- `node scripts/flag-stages-refusals.ts` asks the cluster, as the admin service's account, to write each stage `policy/flags.ts` renders and changes outside the shapes, and, as the line's and flagd's accounts, to stage a flag, each a server-side dry run, and keeps the answers in `deploy/test/flag-stages-refusals.json`, with the policy the cluster answered with. `flag-fences.test.ts` reads them, and fails when the stages the module renders, or the policy in `deploy/`, are no longer those the cluster answered, or when the Role or the policy grows.
- `scripts/flags-refusals.sh` asks the cluster for a second FeatureFlag in `flagd`, the deletion of `flags` and a change to its flags, each a server-side dry run, and keeps the answers in `deploy/test/flags-refusals.json`, which `flag-fences.test.ts` reads.
- `scripts/mark-refusals.sh` asks the cluster, in `website`, for the app's route, split and Middleware as its repository has them and for each way to put the mark back, and sends back unchanged each of those kinds already in `website`, each a server-side dry run, and keeps the answers in `deploy/test/mark-refusals.json`, with Traefik's arguments and environment and the k3s they ran on, which `mark-fences.test.ts` reads.
- `scripts/share-key-refusals.sh` asks the cluster, as `make share-key`'s user, as Argo CD's application controller and as another administrator, to make, change and delete `share-key`, each a server-side dry run, and keeps the answers in `deploy/test/share-key-refusals.json`, with the keys `share-key` holds and whether its public key is the Secret's, which `share-fences.test.ts` reads.
- Each record keeps `policyHash`, sha256 over the policies and Roles its answers came from as `deploy/` renders them (`scripts/policy-hash.ts`): their kind, name and namespace and every field but their metadata and status, keys sorted. Each script computes it first, and stops unless the cluster runs those objects as this checkout renders them: each field as `deploy/` gives it, no field `deploy/` does not give written by anyone but Argo CD (read from their `managedFields`), unchanged when `deploy/`'s fields are applied over them as a server-side dry run (which catches a change inside a selector or a list of rules), Synced in Argo CD's root, at a revision that renders them the same; for egress, no NetworkPolicy on the cluster that `deploy/` does not render, but Argo CD's own chart's; for a record asked as a service account, no binding to it, or to a group it is in, that `deploy/` does not render, but Kubernetes' own defaults. `refusal-records.test.ts` holds every record to the hash of what `deploy/` renders now, so a policy or Role changed without its script run again fails `make check`. A branch that changes one takes its record again on a cluster deployed from that branch (`make up REVISION=<branch>`), then puts root back on main.
