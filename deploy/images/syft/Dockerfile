# Syft's one pin. The dependency graph's workflow (dependency-graph.yml) runs this image by version and digest, and
# build.yml's sign job attests SBOMs with Syft at this version, each reading it from here, from this repository's
# checkout at the workflow's own commit; no workflow writes the version again (scripts/workflows.test.ts). Nothing
# builds this file. Dependabot reads it (.github/dependabot.yml), here rather than under .github/, where its docker
# updates may not write, so its bump of this file is the whole change.
FROM ghcr.io/anchore/syft:v1.57.2@sha256:e97e20b6e6d1699c60296b66ab337941724f9bd06ac279d893eda89601fc4b2a
