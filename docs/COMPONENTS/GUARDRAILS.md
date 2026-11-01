# Guardrails

`make guardrails` takes every proof a guardrail has outside an attack, and records each as `guardrail.proved`, where the console shows it. Part of the [factory plane](README.md#factory-plane).

Spec 6's eleven guardrails, each with the mechanism that holds it, its proofs and the attack made against it, are one catalogue: `policy/guardrails.ts`, which is Martin's (CODEOWNERS). The Guardrails panel draws its rows from it, the red-team menu takes each attack's guardrail from it, and the command takes the proofs it lists.

## The command

`make guardrails` runs `factory guardrails` from the Mac, with the local kubeconfig and Martin's `gh`, as the proofs' store role, `factory_proofs`, through a port-forward to Postgres of its own (15433). The role may append `guardrail.proved` and nothing else, and no other role may append that type ([event store](EVENT-STORE.md)); its password is in the Secret `postgres-proofs`, which `make up` makes.

- **From a clean `main` only.** It refuses to run unless the checkout's `HEAD` is `origin/main`'s head and the tree is clean, untracked files included and no file hidden from `git status` (skip-worktree, assume-unchanged), and records that commit with each proof. It checks again before each append that the checkout is still that commit, clean, so a script that changed the tree stops the run; `main` moving on meanwhile, as a deploy's pin merges, does not. A loosened script in a branch or a worktree cannot record a proof as held.
- **Each proof is recorded as it is taken**, held or not: the guardrails that list it, its mechanism, its output verbatim (at most 4000 characters), the commit, for one taken against the cluster's policies and Roles their hash (`scripts/policy-hash.ts`), and for a proof read from CI, its run.
- **A proof that did not hold fails the command**, which names it, and pages Martin: the line counts a `guardrail.proved` held false, appended by `factory_proofs`, as the security kind `guardrail-not-held` ([alerting](ALERTING.md)). A proof that throws did not hold, and is recorded so, with why.
- **Two are not recorded**, and fail the command too: the stop-the-line drill, when Martin does not say yes at its prompt; and a proof read from CI that finds no run to read, since a CI proof's record must name its run.
- **No schedule.** Each proof shows its age, and a failed one stands until that same proof holds again.

`make guardrails PROOFS="egress bypass"` takes those alone. `factory guardrails --no-record` takes them and records nothing, so it runs from any checkout, for trying a proof.

Every script it runs writes its record to a folder of the run's own (`REFUSALS_OUT`, egress.sh's argument), and leaves `deploy/test/` as it is: the records there are the reviewed ones the new answers are held to.

## The proofs

| Proof | Guardrail | What it takes, and when it holds |
|---|---|---|
| `ci:gates-deterministic`, `ci:one-gateway`, `ci:spend-caps`, `ci:stopped-line`, `ci:public-hostile`, `ci:scope-fence` | 2, 6, 7, 9, 10, 11 | The newest `merge_group` run of `check.yml` in this repository, on `main`'s first-parent history, that ran the `tests` job, past a deploy's run that skipped it. Holds when every part of the job passed there and its commit reached `main` (its pull request's merge) no more than a day before `main`'s head did. A pull request's or a fork's run never counts. Which tests prove each is `CI_PROOFS` in the catalogue, and `apps/factory/test/guardrails.test.ts` fails unless the job runs every one of them. |
| `app-permissions` | 1 | Each GitHub App installed in the organisation, read live, against `APPS` in `scripts/github-settings.ts`: only Apps declared there, each with exactly the permissions declared, and none writing Variables, Administration, Workflows, secrets or environments. |
| `bypass` | 1 | `scripts/github-settings.ts --check --see-bypass` with Martin's `gh`, which GitHub shows each ruleset's bypass list: it fails if the list is unseen or names anyone, if any push bypassed a ruleset in the last week, or on any other drift ([repositories and rulesets](REPOSITORIES-AND-RULESETS.md)). |
| `workflow-refusal` | 1 | `factory github workflow-refusal` in both repositories, as the factory's App, with its key from the Keychain: GitHub must take the control commit and refuse the workflow. |
| `egress` | 5 | `scripts/egress.sh`, each check a record: every check as wanted. |
| `production-writes` | 4 | The rollout, flags, flag stages, share key, route and mark refusals taken again, each answering every case as its record in `deploy/test/` does, against the same policies; and egress.sh's checks of the readers of telemetry, which query and cannot write. |
| `admission` | 3 | `scripts/admission-refusals.sh` taken again, answering as its record does; and each image signed by another identity, where an image of ours runs, refused for its signature. Taken with every image policy enforcing, as `main` has them, so not during a `try-the-line` run. |
| `rollback` | 9 | The last real rollback of a canary, by the line's role alone: its analysis's verdict verbatim, who rolled it back, and how long ago. None, and it does not hold. |
| `stop-the-line` | 9 | The drill, then the last real canary a stop aborted, by the line's role, and how long ago (none, and it does not hold). The gateway's refusal of an agent's call while the line is stopped is `ci:stopped-line`'s. |

A refusal record taken again holds when it was taken against the policies its record in `deploy/test/` was (their hash), and the cluster answered each case as that record says, so the proof holds only while the cluster refuses what the reviewed record says it refuses, and admits its controls.

## The drill

Stop the line cannot be drilled on a dry run's canary, as a dry run's releases make no Rollout. So the drill runs against the line as it is, after Martin says yes at a prompt that says how many agents are running. Stopping loses the step in hand, which runs again from its last event when the line starts.

1. `make stop-the-line`, as Martin's operator role, on the cluster the command was given, with a reason of the drill's own.
2. The line's stop, with that reason, is recorded by one of Martin's roles; every pod in `runners` is gone within three minutes; and, after at least 45 seconds stopped, no work item was taken onto the line.
3. `make start-the-line`, whatever happened, and the command says so if it could not. Interrupted during the drill (Ctrl-C), it starts the line again before it ends.

The drill does not look for the gateway's refusal of an agent's call: the stop ends the agents' pods, often before they call again, while the gateway still sees the line as it was a few seconds before, so it would be a race the drill does not always win. `ci:stopped-line` proves the refusal from the gateway's tests instead, and the line's: every agent's call refused while the line is stopped, and no step started. The drill holds with no agent running. Every reader filters by the role that appended what it reads, so a hole in row security is not the only lock.
