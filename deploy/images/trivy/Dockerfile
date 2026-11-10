# The vulnerability scanner every workflow runs, by version and digest: the image scan and lockfile scan gates
# (app-gates.yml) read it from here, from this repository's checkout at the workflow's own commit, and the lockfile scan
# here (check.yml) from the pull request's base, never from the change's. Nothing builds this file; Dependabot moves it
# (.github/dependabot.yml), which is why it lives outside .github/, where a docker update may not write, and
# scripts/workflows.test.ts holds every use of Trivy to it.
# A change to it passes check.yml only if the image is signed, with GitHub's OIDC issuer, by Aqua's release workflow
# on the tag of the version pinned, named whole:
#   https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v<version>
FROM ghcr.io/aquasecurity/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969
