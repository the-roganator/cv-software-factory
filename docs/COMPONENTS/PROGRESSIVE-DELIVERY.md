# Progressive delivery

A canary against its baseline, with automatic promotion or rollback. Part of the [runtime plane](README.md#runtime-plane).

- **v1:** Argo Rollouts 1.10, installed by Argo CD from its chart at a pinned version, its image by digest, in `argo-rollouts`.
- **Later:** more steps, business metrics.

```mermaid
flowchart LR
  start([New version]) --> q["25% of traffic, 3 minutes"]
  q --> a1{website-step}
  a1 -- pass --> h["50% of traffic, 3 minutes"]
  h --> a2{website-step}
  a2 -- pass --> all([All of it: promoted])
  a1 -- fail --> back([Rolled back])
  a2 -- fail --> back
  bg["website-background, from the start"] -. fail .-> back
```

## The steps are the app's

The app runs as a Rollout in its own repository's `deploy/`, which CODEOWNERS gives to Martin:

1. a quarter of the traffic for three minutes;
2. half for three minutes;
3. then all of it.

An analysis runs after each pause, and one in the background from the start.

- **Services.** The stable version keeps the Service `website`, which the senses watch. The canary's is `website-canary`.
- **The split.** Traefik splits the app's traffic between them through a `TraefikService`, whose weights Argo Rollouts sets with its built-in Traefik router, so no plugin is fetched.

## The judgement is the factory's

`policy/release.ts`, which CODEOWNERS gives to Martin, is rendered to two ClusterAnalysisTemplates (`deploy/base/analysis`, by `release/analysis.ts`; `make check` fails when they are out of date), so nothing in the app's repository can loosen it.

- **Against the baseline.** The canary is compared with its baseline, not with the objectives, which the baseline fails on purpose.
- **Telling them apart.** Their telemetry is told apart by the pod-template hash the collector adds ([telemetry](TELEMETRY.md)), and every query sums over routes.
- **No baseline.** A baseline with nothing to compare fails the canary.

### `website-step`

After each pause:

| Measure | Passes when |
|---|---|
| Enough requests to judge | At least 100 are sent to the canary by the traffic split over the step's three minutes, counted at Traefik, whose metrics Prometheus scrapes, so the journeys' own requests to the canary do not count. Otherwise the step fails, saying so |
| Errors | The canary's share of 5xx answers is no more than a point above the baseline's |
| Latency | Its p99 is no more than a quarter, or 100 ms if that is more, above the baseline's |
| Journeys | No check regresses (below) |

### `website-background`

Throughout:

- errors and latency every minute, once the split has sent the canary enough requests;
- the journeys every three minutes.

Each fails the release at its second failed look, or with auto-rollback off, for errors and latency, pauses it there ([below](#auto-rollback)). The line records each look as it lands ([`canary.measuring`](RELEASE-AND-VERIFY.md#its-events)), for the console to show while the canary holds its step.

### The journeys

The journeys are the [journeys gate](CI-PIPELINE.md#journeys) aimed at the cluster. A Job on the pinned `factory-browser` runs `factory gate journeys`, with the stable Service as the base and the canary's as the change.

- It fails on a check that passes on the base and fails on the change twice, a probe's `/device` among them: a canary that starts to keep anything on a visitor's device, or to ask another origin, is rolled back.
- It writes the checks that regressed, and how many passed of how many ran on each version, to its container's termination message, where the line reads them.

### Auto-rollback

Martin's switch in the console's Controls (`autoRollback` in [`policy/line.ts`](../../policy/line.ts), on by default). On, a measure judged bad fails its run, and Argo Rollouts rolls the canary back by itself. Off, errors and latency judged bad are **inconclusive** instead, and Argo Rollouts pauses the canary at its step for a person: it keeps its share of the traffic until Martin promotes it fully or aborts it. Stop the line still aborts it.

- **How the templates read it.** Errors and latency have a failure condition beside their success condition, and a measurement that meets neither is Inconclusive. Each query answers its figure once with the switch on, and the same figure twice, the second marked `auto_rollback="off"`, only while auto-rollback is off by both of its series: two answers that do not pass are inconclusive, one is a failure. A step pauses on its first bad figure, the background analysis on the look that would have failed it (`inconclusiveLimit` matches `failureLimit`). Argo Rollouts counts failed and inconclusive looks apart, so a switch flipped during a background run can let through one bad look more before the run ends: with the policy's two, a failed look before the flip and an inconclusive one after leave it running, and the third bad look fails it or pauses it, by the switch then.
- **Two series, each held to its pod.** The admin service, which appends the switch, reports it as `admin_auto_rollback`, and the line, from its own read of Martin's latest `controls.changed`, as `line_auto_rollback` (1 on, 0 off), each read from the store each time its SDK collects, and reported on when the read fails, so a word of off is believed only while it is read. Each is believed only from its own pod, by what the collector stamps on it ([telemetry](TELEMETRY.md)), and only from a sample in the last minute. Off needs exactly one fresh series from each, both reading 0: a series missing, stale, doubled or reading anything else rolls a bad canary back. So the admin service, which the internet reaches, cannot switch it off alone, and nothing new writes the Rollout.
- **What it does not cover.** Too few requests still fails a step, a canary with no figure to judge (none of its series reached Prometheus) still fails, and an analysis error still aborts: none is a verdict on the canary. The journeys still roll a canary back: they are a Job, which Argo Rollouts ends only Successful or Failed, so a step's run cannot wait for the Job and then judge its result with the switch.
- **Paused for Martin.** The line holds each work item the paused canary carries, and Needs you shows it ([release and verify](RELEASE-AND-VERIFY.md#release)). His controls are the Canary panel's: Promote fully, past the analysis's verdict, or Abort, which is a rollback all the same: the work item fails Release and triage gets the analysis's verdict, the event recording that he aborted it. The admin service refuses Promote to the next step, Pause and Resume while the controller holds it paused for an Inconclusive run ([admin service](ADMIN-SERVICE.md#the-canarys-controls)). Switching auto-rollback on again leaves a canary already paused for him paused: its run has ended, and nothing judges it again, so it stays his to promote fully or abort; the switch governs the analysis's next verdict, and the hold's reason says so. A release rolled back, by the analysis or by him, can be retried, and is judged afresh.
- **Who is told.** Switching it off needs the passkey again and pages Martin; on informs him ([alerting](ALERTING.md#security-events)). The admin service's word differing from his recorded switch for two minutes pages him too ([alerting](ALERTING.md#changes-no-event-records)).

## Whose requests are judged

Errors and latency are the visitors' and the [traffic generator](TRAFFIC-GENERATOR.md)'s, so the canary and its baseline are judged on the same mix of requests.

- **Left out:** the factory's own requests send the header `x-unmeasured` (`UNMEASURED`, `senses/http.ts`):
  - the journeys and the pictures, which ask both Services directly;
  - the probes, the crawler and the page reader, which watch the stable Service throughout, so whatever their checks provoke weighs on neither version;
  - the [admin service](ADMIN-SERVICE.md#whether-the-app-holds-the-flags), which asks each pod of both versions, at its own address, for `/health` once a minute, for the revision of the flags it holds.
- **No record.** The app keeps no record of those requests in its request log, request metrics or traces, so the three still agree ([log watcher](LOG-WATCHER.md#agreement)). An error one causes is still logged, with no trace.
- **Only from inside.** The app's public route removes the header (the Traefik `Middleware` `visitors`, in the app's repository), so only a client in the cluster, asking the Services directly, can be left out. Admission holds every route to the app to that Middleware, and every Middleware in `website` to the strip ([the mark](ADMISSION-CONTROL.md#the-mark)).
- **Kept:** the traffic generator never sends it. It stands in for the visitors, and goes in through the split as they do.
- **Kept too:** the crawler's one ask for each static asset without the mark, whose caching only a visitor's answer shows ([not counted](PROBES-AND-CRAWLER.md#not-counted)): a few quick answers a crawl, counted as a visitor's, on the version the crawl watches.

## Rolling back and stopping

- **A failed analysis** rolls the release back, and each measure it failed on is a signal from the `canary` sense ([rollback signals](RELEASE-AND-VERIFY.md#rollback-signals)).
- **Stop the line** aborts a release in flight, and the line records the abort ([`release.aborted`](RELEASE-AND-VERIFY.md#its-events)), by `stop`. From the console's header, the [admin service](ADMIN-SERVICE.md#stopping-and-starting-the-line) aborts it with its own Role on the app's Rollout, after the line's stop is recorded; `make stop-the-line` aborts every one with Martin's own kubeconfig (`scripts/abort-canaries.sh`), and works when the console does not. It stays aborted until he retries it or the next deploy starts another.
- **Martin's controls.** From the console's Canary panel he promotes a canary to the next step's weight or fully, pauses it and resumes it, aborts it, and retries a release that was stopped, through the [admin service](ADMIN-SERVICE.md#the-canarys-controls). Each is the patch `kubectl argo rollouts` makes, and an event, `release.controlled`. His abort is no signal, as Stop the line's is not. There is no rollback control: a rollback stays the analysis's alone, and the canary needs nobody to press anything.
- **One right to change a Rollout.** The admin service's, on the app's Rollout alone, held by an [admission policy](ADMISSION-CONTROL.md#the-admin-services-hold-on-the-rollout) to the fields those controls set. The rest of the factory holds none, and a test fails a role that would give one, or a Role or policy that grows (`release-fences.test.ts`).
- **Argo CD leaves a pause alone.** The app's Application ignores the Rollout's `spec.paused`, as it ignores the traffic split's weights, so self-healing never resumes a canary Martin paused.
