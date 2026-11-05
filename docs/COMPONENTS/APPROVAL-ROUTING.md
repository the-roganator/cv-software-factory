# Approval routing

Sends risky changes to a human. Part of the [GitHub plane](README.md#github-plane).

- **v1:** one required check, `review`, posted by the review App from `main`'s copy of `review.yml`, works out a pull request's risk tags from its diff and passes it by one rule or holds it for Martin ([ADR 0014](../architecture/adr/0014-merge-queue-and-review-gate.md#how-the-gate-routes)); the planner's `out-of-scope` holds a spec before any code is written.
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
