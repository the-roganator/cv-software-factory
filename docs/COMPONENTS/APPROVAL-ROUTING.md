# Approval routing

Sends risky changes to a human. Part of the [GitHub plane](README.md#github-plane).

- **v1:** the line adds its own pull request to the merge queue when the gate's rule, Martin's autonomy level and auto-merge allow, and otherwise holds it in Needs you, saying why ([the line's part](#the-lines-part)); one required check, `review`, posted by the review App from `main`'s copy of `review.yml`, works out a pull request's risk tags from its diff and passes it by one rule or holds it for Martin ([ADR 0014](../architecture/adr/0014-merge-queue-and-review-gate.md#how-the-gate-routes)); the planner's `out-of-scope` holds a spec before any code is written.
- **Later:** a Critical vulnerability's fix passing under Guarded (Part D).

## The gate

`scripts/review-gate.ts` reads only GitHub's API and GHCR, never checking out the pull request, and decides by `scripts/review-routing.ts`. Both, the workflow that runs them, and the verdict's shape (`policy/review-verdict.ts`) are Martin's by CODEOWNERS.

| Tag | Given by |
|---|---|
| `test-loosening` | each test that test integrity excused as one the spec contradicts, from the warning it annotates each with on its `gates / test integrity` run |
| `dependency-change` | a lockfile or package manifest (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and the like), or `.npmrc` or `.pnpmfile.cjs`, which say where packages come from and what runs as they install, anywhere |
| `security-headers` | the app's header settings, `src/headers.ts`; or a line added or removed anywhere in the app's `src/` (not its tests) that names a security header in any case (`Content-Security-Policy` and its `-Report-Only`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, the three `Cross-Origin-*-Policy`) or `SECURITY_HEADERS`, so a header set outside that file is caught too; or such a file GitHub gives no patch of |
| `code-owned` | a path CODEOWNERS on `main` gives Martin; or a diff too large for GitHub to list whole |
| `release` | release-please's branch, or a change to a release's files alone |
| `improvement` | the app's typed list of flag names, `src/flag-names.ts`; or a line of the app's code (`src/`, not its tests), added or removed, that names `flag` or calls `.on(`; or such a file GitHub gives no patch of |
| `out-of-scope` | the planner or the reviewer, on the spec: held before the coder starts, in every mode (`ALWAYS_HELD`, `line/machine.ts`; [holds](ORCHESTRATOR.md#holds-and-martins-answers)). Not in a diff. |

The rule, the first that holds:

| Rule | Passes |
|---|---|
| `martin-opened` | a pull request Martin opened from a branch here |
| `martin-approved-head` | one whose head Martin's latest verdict approves: a push after his approval needs it again |
| `exact-pin` | the factory's App's, every changed line a `digest:` under `deploy/`, each image signed by its repository's `build.yml` on `main` (cosign), from a commit `ahead` of the pin it replaces |
| `low-risk` | the factory's App's, in the app's repository, with no tags and a successful test-integrity run by GitHub Actions at its head |
| `lights-out` | the same with tags, while the app's `AUTONOMY` variable is `lights-out`, but never with `release`, `improvement` or `code-owned` |
| `held` | anything else, saying why |

A risk label removed by anyone but Martin holds the pull request from every rule after his. In this repository, the App's pull requests pass only as exact pins, whatever `AUTONOMY` says. A missing, pending, skipped, cancelled, failed or foreign test-integrity run holds the App's pull request; so does one of a pull request that changes `.github/`, or that is into a branch other than `main`, either of which would be a workflow other than `main`'s. An exact pin needs every file GitHub lists, and a digest only one image entry has.

## Who reads which signal

- **The gate** reads the diff, CODEOWNERS on `main`, Martin's reviews, the pull request's label events, test integrity's run, and the caller's `AUTONOMY` variable. It cannot read the factory's store, and merges nothing: a pull request merges only once someone adds it to the merge queue.
- **The line** reads the store's autonomy level and auto-merge switch (Martin's controls), the gate's verdict from the review App's own `review` check on the pull request's current head, whether the pull request conflicts with main, and the merge queue's word on what it added. It adds its own pull request to the queue only when auto-merge is on, the gate's rule is one the level allows, and the head is the one its own gates and reviewer passed; never an improvement, a release, a red-team branch or a work item whose spec was tagged `out-of-scope`. So the stricter of the two always wins: a fault in the line cannot merge what the gate fails, and the gate alone merges nothing.

## The line's part

| Level | Rules the line merges by, with auto-merge on (`ENQUEUES`, `policy/line.ts`) |
|---|---|
| Supervised | none |
| Guarded | `low-risk`, `exact-pin`, `martin-approved-head` |
| Lights-out | Guarded's, and `lights-out` |

Anything else is held in Needs you, as a `merge` hold naming the gate's rule, its tags with what gave each, its words, and why the line does not merge it; where Martin's approval of the head on GitHub would send it to the queue, the hold says so. Only a pull request the gate refused (`held`) is recorded as a refusal, `review-gate`, once for each head, signed by the GitHub worker. A merge held because the level or auto-merge does not allow it is his ordinary merge.

The gate judges an App pull request as it opens, before test integrity has run, and holds it then; it judges again once the gates finish. A verdict whose `review` check completed before GitHub Actions' latest test-integrity run on the head did counts nothing that run found, so the line neither refuses, holds nor queues on it, held or passing: the change waits at Review for the gate to judge again. Test integrity's run is the one check the gate reads, and the gate judges again when its workflow ends, which may be before the head's other checks, so the line times the verdict against that run alone. Should no later verdict come within fifteen minutes of the head's last check finishing (`REJUDGE_MS`), the merge is held for Martin as having no verdict to trust (`no-verdict`), and nothing is refused. The queue taking a pull request out is recorded (`pull-request.dequeued`), with the checks that failed, and holds it. [The line's merge](ORCHESTRATOR.md#the-merge) has the rest.

`AUTONOMY` is a variable of the app's repository, which only Martin can set: `gh variable set AUTONOMY -R the-roganator/cv-worlds-worst-website -b lights-out`, and `gh variable delete AUTONOMY -R the-roganator/cv-worlds-worst-website` to go back. This repository's is never read.

## The verdict

The check's summary has a line for each pull request it judged, with its rule and each tag with what gave it, which Needs you shows, and a block the line parses with `readVerdict` (`policy/review-verdict.ts`):

```
<!-- review-verdict v1
{"commit":"<the commit the check is on>","judged":[{"number":7,"head":"<sha>","rule":"held","tags":[{"tag":"dependency-change","because":["pnpm-lock.yaml"]}]}]}
-->
```

A `held` entry carries `pending` when the gate held it only to wait for something it could not read yet: test integrity's run missing, queued or in progress at the head (as it is when a pull request opens), or a read of GitHub that failed. Judged again once it can read it, the gate may pass the pull request, so a pending hold is a wait, not a refusal, and its words say what it waits for. A hold that anything the gate did read decided carries none: a tag the level does not pass, a removed risk label, a base other than `main`, a test-integrity run another app posted, or one that failed, was cancelled or was skipped, and anything in this repository but an exact pin. The field is optional, so the block is still version 1.

Read it only from the check named `review` that the review App (5470762) posted for the pull request's current head: the factory's App can post check runs too. A summary with no block, two, or one that does not parse whole (`pending` beside a passing rule among it) carries no verdict.

To see what the gate would say of a pull request, with nothing posted:

```sh
GH_TOKEN="$(gh auth token)" AUTONOMY= mise exec -- node scripts/review-gate.ts --print the-roganator/cv-worlds-worst-website <number>
```
