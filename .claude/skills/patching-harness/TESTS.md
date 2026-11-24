# Patching: the tests that should pass

Decided by Martin on 15 November 2026. Each test is an outcome, not a step. The list is his; change it only with him.

## What every test asserts

1. It starts from a real pin at a known vulnerable version, already in the scratch repository's baseline.
2. It ends merged and deployed, and the next scan no longer reports the finding.
3. Nobody touched it: no approval, no hold answered, no check re-run by hand.
4. One pull request carries the whole change, with everything that must move with it.
5. It is done within a time limit (an hour from scan to deployed, to start with).
6. It is clean: no worker logs an error, no pod is left unhealthy, and for the app the canary completes.

The verdict comes only from the real thing: a real pull request, real CI, the real gate, the real merge queue, a real
deploy and the next real scan. A local run is a filter before that, never the proof.

## The moves that must merge, nobody touching them

| # | Move | A real example | On 15 November |
|---|---|---|---|
| 1 | Factory: a third-party image under `deploy/` | Postgres 18.6-alpine3.24 to 18.7, #1137 | merged unattended |
| 2 | Factory: a chart within its major | prometheus 29.35.0 to 29.47.2, #1135 (its subchart kube-state-metrics goes 8.6.0 to 9.0.1) | held by the gate |
| 3 | Factory: one chart at two Applications | opentelemetry-collector 0.174.0 to 0.178.3, #1142 (otel-collector and pod-logs) | held by the gate |
| 4 | Factory: a chart's major | loki 18.13.7 to 21.2.3, #1127; grafana 13.2.7 to 14.4.1, #1132 | held by the gate |
| 5 | Factory: several images in one file | Kyverno's four, v1.19.1 to v1.20.0, #1128 to #1131 | four pull requests, each held |
| 6 | Factory: an image with a paired library | Playwright v1.65.0 to v1.65.1, the image and the lockfile's library, Dependabot's #1035 | left to Dependabot |
| 7 | Factory: a lockfile package also in our image | issues #1138 and #1139 (the sealed state names them) | an issue each |
| 8 | App: a lockfile package, direct and indirect | `@grpc/grpc-js` 1.14.5 to 1.14.7, app #53; `protobufjs`, app #55 | merged, with holds |
| 9 | App: a lockfile package at two versions | none with an advisory; `es-module-lexer` is at 2.3.2 and 3.0.2 | fails |
| 10 | App: a runtime image that brings another Node | distroless `nonroot` to `sha256:6abfcb36…`, app #64, work item #1039 | red: `image builds`, then held |
| 11 | App: the build image, Node's own advisory | none open; an older Node staged | not tried live |
| 12 | App: an image under `deploy/` | Syft v1.54.0 to v1.57.1, app #43 | Dependabot's, with Martin's approval |
| 13 | App: a Critical fix | none; `make drill-vulnerability` stages one | never run |
| 14 | Either: what mise or the Makefile pins; k3s | none open | an issue, or the cluster's command |

k3s: its pull request merges as any other. Applying it is `make upgrade-cluster` on the host, which is not automated
and is no part of the test.

## The moves that must not merge

| # | Move | Must |
|---|---|---|
| N1 | It breaks one of the repository's own tests | open no pull request, or never merge |
| N3 | It goes backward, or to a digest the registry does not serve | be refused |
| N4 | It changes anything beyond its pins | be refused |
| N5 | An image of ours that is not signed on `main` | be refused |

N2, a move that makes the findings worse, is dropped (Martin, 17 November 2026): a fix does not normally make things
worse, and the next daily scan picks up whatever a move brought, as it would any finding.

## By autonomy level

Martin's word, 17 November 2026. The tests above are judged at the level the scratch cluster's line is set to.

| Level | What merges with nobody touching it |
|---|---|
| Supervised | no move and no fix of the line's; the factory's local deploy pin, which only runs what Martin merged, still does |
| Guarded | every move but a major (4a, 4b), which is held; a major that clears a Critical merges |
| Lights-out | every move, majors too |

For a move nothing in the cluster runs (9, 14a, 14b), merged is the end: there is no deploy to wait for.
