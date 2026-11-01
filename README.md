# Software Factory

[![check, the merge queue's latest run](https://github.com/the-roganator/cv-software-factory/actions/workflows/check.yml/badge.svg?event=merge_group)](https://github.com/the-roganator/cv-software-factory/actions/workflows/check.yml?query=event%3Amerge_group)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/the-roganator/cv-software-factory/badge)](https://scorecard.dev/viewer/?uri=github.com/the-roganator/cv-software-factory)
[![release](https://img.shields.io/github/v/release/the-roganator/cv-software-factory)](https://github.com/the-roganator/cv-software-factory/releases)

AI agents and deterministic gates that look after a live web app. They notice problems, write fixes, prove the fixes are safe, ship them as canaries and check that they worked. No person writes the fixes; people own the rules.

I'm Martin Rogan. This is my portfolio: a working system you can open and judge for yourself, rather than a description of what I can do. [Why it exists and what it has to prove](docs/INTENT.md).

> [!NOTE]
> **Under construction.** Milestones 1 to 6 of 11 are done ([the plan](docs/PLAN/README.md)): the repository, the toolchain, CI, a local Kubernetes cluster with GitOps and telemetry, the app the factory looks after, the console, drawn from an append-only event store and live in the browser, the factory's senses and triage, the line that fixes, and shipping safely. Agents in fenced sandboxes plan a fix, write a failing test and then the fix, and review it, and the factory's GitHub App opens the pull request, which waits for my approval. Once I merge its deploy, the fix ships as a signed image that admission control lets in, runs as a canary beside the version it replaces, promotes or rolls itself back, and is verified by the sense that first saw the defect, with the scoreboard counting it. Seeded defects have gone all the way with no human code, and a bad change has been rolled back with nobody touching it. Next is milestone 7: admin mode in the console, improvements behind feature flags, and every guardrail proved.

## What it will do

The factory looks after [The World's Worst Website](https://github.com/the-roganator/cv-worlds-worst-website), a small shop that is broken on purpose: its first commit already holds more than twenty defects, and nothing public says where they are. Its line has eight stages:

**Sense → Triage → Plan → Build → Gates → Review → Release → Verify**

Probes and telemetry notice a defect. Triage turns it into a ticket with evidence. A planner writes a testable spec, a coder agent writes a failing test and then the fix, and deterministic checks decide whether it can merge. Argo Rollouts ships it to a small share of traffic, compares it with the running version, and promotes or rolls back on its own. A console shows all of it, live or as a replay you can scrub through.

It is safe because of mechanisms, not because the prompts ask nicely: agents can't change the rules, can't build what ships, and can't touch production. The [guardrails](docs/SPECIFICATION.md#6-guardrails) list each one and what enforces it.

## Run it locally

You need macOS or Linux, [mise](https://mise.jdx.dev) and a container runtime ([OrbStack](https://orbstack.dev) on a Mac).

```sh
mise install     # Node, pnpm, kubectl and its Argo Rollouts plugin, k3d, helm, kustomize, Argo CD's CLI, cosign, step, gh, as mise.lock holds them
make up          # a local Kubernetes cluster; Argo CD deploys the rest from this repo
make samples     # twelve sample work items, so the console has something to show
make status      # what is running, and where to open it
make egress      # prove the fences: of the factory's own pods, only the gateway and the GitHub worker leave the cluster
make stop-the-line   # agents stop, workers take nothing new, a canary in flight aborts
make start-the-line  # the line takes work again
make guardrails  # take every guardrail's proof from a clean main, and record each where the console shows it
make down        # delete the cluster; nothing is left behind but the local certificate authority
```

The console is at `https://console.localhost:8443`. The first `make up` makes a certificate authority for it that can sign for `localhost` names only, and macOS asks once whether to trust it; decline, and the console shows behind a browser warning, and secure cookies and passkeys, which the admin sign-in needs, won't work there. `make untrust-ca` removes it from the Keychain and deletes it.

A store holds samples or the factory's own work, never both. `make real-store` empties it for real work: use it when you want to watch the factory find and triage defects in the app, rather than browse the samples.

The factory's workers run in the cluster too: the model gateway, triage, the intake and log watcher, the probes and crawler that look at the app, the line and its GitHub worker, the traffic generator that gives a canary enough requests to judge, and the scoreboard, alone in its own namespace. The gateway asks Jev (TypeSafe) with a key from `TYPESAFE_API_KEY` or the macOS Keychain (`typesafe-api-key`), which `make up` hands to the cluster and writes nowhere else; with no key it replays recorded answers only. Of the factory's own pods, network policies let only the gateway and the GitHub worker reach the internet. In the namespaces where the factory, its runners, the app and the scoreboard run, admission control runs only images the pipeline signed, and the few third-party images it names by digest.

`make` on its own lists every target. The first `make up` takes a few minutes while images download.

## How changes land

Every change is a pull request, squash-merged into `main` once the required checks pass: lint, type-check, tests and an image build. A release pull request that the factory's GitHub App opened, and a deploy of its that changes nothing but the digests in its pin files, skip the browser tests, and so does anyone's that changes only manifests under `deploy/`; the release and the deploy skip the other tests too, and pass only once the merge queue has passed them on the commit each is made on; a deploy or manifests pull request checks that each image it pins was built from `main` instead of building one. The merge queue runs everything again, but for a deploy, which it runs as light. Actions are pinned to full commit SHAs, workflows get minimal permissions, and outside pull requests never run with secrets. The settings of this repository and the app's are applied by [one script](scripts/github-settings.ts), so they can be reviewed like code, and the app's repository calls this one's title check, CodeQL and Scorecard workflows at a pinned commit, so nothing written there can loosen them.

**Review:** a required check, `review`, posted by a GitHub App of its own, passes a pull request I opened, or one whose latest commit I approved; `CODEOWNERS` names me for workflows, deployment, policy and the gates' configuration. The factory opens its own pull requests as its GitHub App, so each waits for my approval. Pull requests merge through GitHub's merge queue, which tests each on `main` as it will be, so none has to be brought up to date first ([ADR 0014](docs/architecture/adr/0014-merge-queue-and-review-gate.md)).

## Read more

- [Intent](docs/INTENT.md): why this exists, and the bar everything is held to
- [Specification](docs/SPECIFICATION.md): what is being built
- [Components](docs/COMPONENTS/README.md): which part does what
- [Decisions](docs/architecture/adr/): the major ones, and why
- [Contributing](CONTRIBUTING.md): reporting a bug or an idea, and changing the code, its tests included
- [Security](SECURITY.md): reporting a vulnerability privately

[MIT licence](LICENSE)
