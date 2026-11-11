# Factory GitHub App

The factory's identity in GitHub. Part of the [factory plane](README.md#factory-plane).

- **v1:** `mrogan-software-factory`, owned by the organisation `the-roganator` and installed there on the two public repositories alone, never on `cv-software-factory-private`. Its work shows as `mrogan-software-factory[bot]`. The GitHub worker asks GitHub for the installation of each repository it acts on, so no installation id is configured.
- **No webhook:** the factory polls.

Only the [GitHub worker](GITHUB-WORKER.md) holds its key.

Its issues and pull requests are opened by its bot user, `mrogan-software-factory[bot]`, user id 337765427 (not the App's id, 5187559). The worker knows the App's own issues and pull requests by that id ([its issues and pull requests only](GITHUB-WORKER.md#its-issues-and-pull-requests-only)).

## Permissions

- **Allowed:** contents (branches), pull requests, checks, issues. Adding its own pull request to the merge queue, as the line does, uses contents and pull requests, and nothing more. None of its pull requests changes a workflow, which GitHub would not merge for a token without workflows.
- **Read only:** Actions, to find the vulnerability scan's last run and download its `moves` artifact, and security events, to read the scan's code-scanning alerts ([the GitHub worker's `moves`](GITHUB-WORKER.md#for-patching)). It may neither start, re-run nor cancel a run, nor dismiss or reopen an alert: an alert's state is the exceptions policy's alone. Martin accepts these on the installation once `scripts/github-settings.ts` names them.
- **Denied:** workflows, administration, variables, bypassing rulesets.

`APPS` in `scripts/github-settings.ts` declares these, and the review App's and the drift check App's, and its test fails if any grants a write of variables or administration. `apps/factory/test/credentials.test.ts` fails if any pod in a profile's rendered manifests but the GitHub worker's holds a GitHub credential, or if the GitHub worker's is another App's.
