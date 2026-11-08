# Shared gates

One rule for both public repositories, out of the app repository's reach. Part of the [GitHub plane](README.md#github-plane).

- **v1:** reusable workflows in this repository, called from the app's repository at a pinned commit:
  - the title check;
  - CodeQL;
  - Scorecard;
  - the daily scan (`vulnerabilities.yml`), whose results reach the caller's own code scanning ([security scanning](SECURITY-SCANNING.md#the-daily-scan));
  - the app's gates (`app-gates.yml`).

The app's gates take their scripts from this repository at that commit (`apps/factory/src/gates`, Node with no dependencies, from a sparse checkout), and the probes and crawler from the `factory-browser` image the local profile pins. The daily scan takes its scripts and Trivy's pin from this repository at that commit too, and reads the caller's checkout as data. They see only the base's checkout and the change's, but for test integrity, which reads the pull request's description through the API for the tests its spec contradicts. What they check is in the [CI pipeline](CI-PIPELINE.md), [test integrity](TEST-INTEGRITY.md) and [security scanning](SECURITY-SCANNING.md).
