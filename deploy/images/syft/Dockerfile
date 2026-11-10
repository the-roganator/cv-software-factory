# Syft's one pin. The dependency graph's workflow (dependency-graph.yml) runs this image by version and digest, and
# build.yml's sign job attests SBOMs with Syft at this version, each reading it from here, from this repository's
# checkout at the workflow's own commit; no workflow writes the version again (scripts/workflows.test.ts). Nothing
# builds this file. Dependabot reads it (.github/dependabot.yml), here rather than under .github/, where its docker
# updates may not write, so its bump of this file is the whole change.
FROM ghcr.io/anchore/syft:v1.54.0@sha256:0356562f495d432056237fbea5cbc2d4839c9c75cd500784a66de2e7cc95ca7c
