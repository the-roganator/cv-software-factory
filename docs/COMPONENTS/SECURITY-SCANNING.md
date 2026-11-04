# Security scanning

Code, dependencies, images and secrets. Part of the [GitHub plane](README.md#github-plane).

- **v1:** CodeQL, Dependabot, GitHub secret scanning, and two gates on the app's pull requests.
- **Later:** Semgrep, licence checks.

## CodeQL

`codeql.yml` analyses the TypeScript and the workflows, with the `security-and-quality` queries, on every pull request, the merge queue's commit, `main` and once a week, in both public repositories: the app's calls it. Each repository's `main` ruleset holds a merge while CodeQL finds a new security alert of medium severity or higher, or a new error ([repositories and rulesets](REPOSITORIES-AND-RULESETS.md#the-ruleset)); a false positive is dismissed in code scanning, with a written reason.

## On the app's pull requests

- **Dependency review** (GitHub's) fails a dependency with a known vulnerability the change brings in.
- **Trivy** (pinned by digest) scans the base's image and the change's, and fails on a high or critical vulnerability only the change's has.
