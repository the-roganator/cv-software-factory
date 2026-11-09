# The SBOM tool the dependency graph's workflow (dependency-graph.yml) runs, by version and digest, read from here, from
# this repository's checkout at the workflow's own commit. Nothing builds this file. Dependabot reads it
# (.github/dependabot.yml), here rather than under .github/, where its docker updates may not write, and
# scripts/workflows.test.ts holds its version to the Syft build.yml attests SBOMs with, so a bump of one moves the other
# in the same pull request.
FROM ghcr.io/anchore/syft:v1.54.0@sha256:0356562f495d432056237fbea5cbc2d4839c9c75cd500784a66de2e7cc95ca7c
