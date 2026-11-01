# CI pipeline

Deterministic gates (spec 4.1). Part of the [GitHub plane](README.md#github-plane).

- **v1:** GitHub Actions on GitHub-hosted runners, with a target under 3 minutes and the jobs in parallel.
- **Later:** visual regression and performance budgets for the app, an active DAST scan, load tests.

## The jobs

- lint and format;
- type-check;
- the generated files checked against their sources, and the console's built browser code against its budget, in gzipped bytes (`apps/console/budget.json`);
- unit and integration tests;
- the manifests rendered;
- the app's gates ([shared gates](SHARED-GATES.md)), the journeys among them;
- the console's browser tests, in the pinned Playwright image, its visual snapshots among them, and its first meaningful view timed, within two seconds on a throttled phone, on a runner of its own;
- ZAP's baseline scan of the console signed in as Martin;
- each image built, and a runner's prepare step run in the runner image ([agent runners](AGENT-RUNNERS.md#trying-a-runner)).

## ZAP's baseline scan

`make zap` runs it on the Mac, as CI's `zap` job does (`apps/console/zap/scan.ts`), against the console's server and the [admin service](ADMIN-SERVICE.md) on one origin, behind a proxy standing in for Traefik, on a throwaway store. A browser enrols a passkey through the console's enrolment page with a virtual authenticator, so it signs in as Martin's does and no image holds a way in made for tests. ZAP's baseline (its spider, then its passive rules, which read each answer and send no attack) then runs in its pinned image, with Martin's session and token on every request, reading the pages the console's script draws and the admin service's answers too (`hooks.py`).

- **Any finding fails it,** unless `apps/console/zap/rules.tsv` keeps an exception with its reason beside it; a test fails an exception with none.
- **A scan that reached nothing fails too:** it must have read the page and Martin's session, signed in.
- **A ZAP that stops before it answers stops the scan then,** with ZAP's log, rather than after zap-baseline's ten-minute wait. Its proxy has a port of its own, below the range outgoing connections take theirs from, since on Linux it shares the runner's network.
- **Its rules are the newest this ZAP can run, on each scan,** beta ones included: ZAP's image moves by hand, but zap-baseline.py, started without `-silent`, updates ZAP's add-ons (`-addonupdate`) and installs the beta passive rules (`-addoninstall pscanrulesBeta`) as it starts, when ZAP's add-on store answers. A rule published after the pin still finds what it looks for, unless it needs a newer ZAP, so a new finding can fail a pull request that changed nothing, and is read and fixed or given an exception in `rules.tsv` like any other.
- The report is the job's artifact, `zap-report`.
- It passes into the required `browser tests` check, as the browser tests do.

## Journeys

The base's and the change's images are built and run as containers in the runner, and `factory gate journeys` runs the probes and the crawler (with axe) against both at once.

```mermaid
flowchart LR
  base[Base image] --> run[Probes and crawler, against both]
  change[Change image] --> run
  run --> check{"A check passes on the base<br>and fails on the change?"}
  check -- no --> pass([Pass])
  check -- yes --> again["Run again: only the probes that failed,<br>and the crawl only if a check of its failed"]
  again -- fails again --> fail([Fail])
  again -- passes --> pass
```

- **It fails** on a check that passes on the base and fails on the change twice.
- **Nothing on the visitor's device, nothing from elsewhere.** Each probe also answers `<probe>/device`: whether, by the end of it, anything is on the device, a cookie or anything a script stores (local or session storage, IndexedDB, Cache Storage, a service worker), or its pages asked another origin (`senses/device.ts`, `senses/observe.ts`). It is keyed on the probe's own route, so the base's and the change's are the same check. The app keeps nothing on a visitor's device, so a change whose pages start to keep anything there, or to ask another origin, fails as any check that regresses does. Reading it adds milliseconds to each probe. Verify and the probes that look after the live app do not ask.
- **A check the base could not tell about** (the crawler's trouble) is reported, not failed on.
