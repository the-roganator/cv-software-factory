# Repositories and rulesets

A single path for change. Part of the [GitHub plane](README.md#github-plane).

- **v1:** one ruleset on `main`, the merge queue and the review gate (ADR 0014), and the environments that hold an App's key, applied to both public repositories by `scripts/github-settings.ts` and checked weekly for drift.

## Where they live

Both public repositories are the organisation `the-roganator`'s, since GitHub offers the merge queue only to an organisation's repositories. `cv-software-factory-private` stays with Martin's account, `mrogan`: the Apps installed across the organisation, the review App on every repository there, must never reach the answer key, which only the scoreboard reads.

## The ruleset

| Ruleset | Requires | Bypass |
|---|---|---|
| `main` | Pull requests only, squash merges, required checks, `review` among them, linear and signed history, the merge queue | Nobody |

There is no rule that a branch be up to date with `main`: the queue tests each pull request on `main` as it will be, with those ahead of it, on a commit of its own, and every required check runs there too: in full, but for the factory's App's deploy, which runs there as light as on its pull request ([ADR 0005](../architecture/adr/0005-images-deploy-through-pull-requests.md)). Each is squashed, every one of a group must pass, up to five are tested at once, and a group whose checks say nothing within the hour leaves the queue. GitHub's own review rule is not used: the queue admits only a pull request that meets every rule, so review is a check it can wait for.

## The review gate

`review` is required from the review App alone (App ID `5470762`), so no workflow's job of that name stands in for it. `review.yml` judges each pull request with `scripts/review-gate.ts`, and posts the check as the review App: it passes when Martin opened the pull request, by his account's id, or approved its head after the last push. `review-requested.yml` asks for it when a pull request opens, moves or is edited, on a review, and in the merge queue, and `review.yml` runs only after it, on `workflow_run`, as `main` has it, or as the app's repository calls it, never on `pull_request_target`. Every other required check runs in the queue too: `check.yml` and `pr-title.yml`, and the app's gates (`app-gates.yml`), which the app's repository calls from its queue, read-only and with no secret.

The review App's key is kept only in each repository's `review` environment, as `REVIEW_APP_PRIVATE_KEY`, which only workflows on `main` may use. `github-settings.ts --check` reports the environment as drift if it is missing, any other branch may use it, or it holds no key.

No required check is the reviewer agent's (`factory review`) or posted by the factory's App: each is pinned to GitHub Actions or the review App, and `scripts/github-settings.test.ts` fails if one is not. `scripts/merge-decisions.test.ts` walks the imports of the app's gates, the line's reading of the checks and the review gate, and fails if any reaches the gateway, Jev, the agents or a package it does not name, so no model decides a merge.

## The drift check

`drift-check.yml` runs `github-settings.ts --check` on Mondays and by hand, with a workflow token that may only read this repository's contents, for its checkout, and fails if either repository's rulesets or key environments differ from the script's in anything it can see. A failed run reaches Martin as any failed scheduled run does, by GitHub's email.

The rulesets, environments' branch policies and the names of their secrets need Administration, Actions and Environments read, which no workflow token has, so it reads as the drift check App (`the-roganator-drift-check`), installed on both repositories, which may read administration, Actions and environments and nothing else. Its key is in this repository's `drift-check` environment, which only `main` may use, as `DRIFT_CHECK_APP_PRIVATE_KEY`, with its Client ID beside it as the variable `DRIFT_CHECK_APP_CLIENT_ID`; until both are there, the run fails, saying so. GitHub shows a ruleset's bypass list only to a reader who may change it, and the App may not, so it never sees that list: the check warns, with an annotation on the run, that it did not compare it, never reads it as nobody, and passes on the rest; drift it can see is an error annotation, and fails the run. Whether GitHub sent the list decides, not whose token read it: run by the `gh` of someone who may change the rulesets (Martin's), `--check` compares the list too, and fails if anyone may bypass; run by any other token, a personal one with only Administration read included, it warns as the App's run does. The App is given no Administration write to see it, as its key in an Actions environment could then change the rulesets. `make guardrails` proves the list with Martin's `gh`, through `--check --see-bypass`, which fails on whatever it could not see as on drift, so its proof cannot pass without reading the list ([guardrails](GUARDRAILS.md)).

It also reads each repository's record of the rulesets' verdicts on pushes (rule suites) for the last week, which Administration read may see, and fails on any push that bypassed a ruleset: a bypass used shows there even when the list names nobody now. It says how many there were, and the latest: who, what and when. A reader that may not read the record is warned, as for the list. Martin's `gh` reads it; the drift check App, with Administration read, should, and its first run says.

## The workflows

`scripts/workflows.test.ts` reads every workflow and fails if one runs on `pull_request_target` or on a runner that is not GitHub-hosted, or if any but `review.yml` and `drift-check.yml` holds a secret. Those two take theirs from an environment only `main` may use, only that environment's key, and check out nothing but a sparse copy of `main`'s own files at the workflow's commit. It fails too if any but `copilot-held-runs.yml` may write Actions, which can delete any run.

`copilot-held-runs.yml` deletes, every half hour and by hand, the runs of `review-requested.yml` and `review.yml` that GitHub held for Copilot's reviews (ADR 0014), each of which would leave a red cross on a pull request's commit or on `main`. `scripts/copilot-held-runs.ts` deletes a run only of those two workflows, by their files, that Copilot's account, by its id, login and type, started and triggered, held or failed, with no job; a fork's held run waits for Martin's approval as before. Its schedule runs `main`'s copy, and its job refuses any other ref, though a dispatch from another branch would run that branch's copy, which only someone who may push a workflow can make. It holds no secret: the workflow's own token may write Actions and read the contents, and the step that installs Node is not given it. It has no window in time, and reads up to a thousand runs of each workflow with each conclusion in a pass, so its first run deletes every held run left before it, about a hundred; were there more than a thousand of one kind, the oldest would wait for the passes after.

## Also

- **CODEOWNERS** on workflows, policy and test config.
- **Actions** pinned by SHA.
- **Copilot** reviews Martin's own pull requests, by his account's automatic code review rather than a ruleset, which cannot tell one author from another. So Dependabot's and the App's go without it.
  - It follows `.github/copilot-instructions.md`.
  - Its comments, like any, must be resolved before a merge.
