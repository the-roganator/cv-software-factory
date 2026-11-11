# Syft's one pin. The dependency graph's workflow (dependency-graph.yml) runs this image by version and digest, and
# build.yml's sign job attests SBOMs with Syft at this version, each reading it from here, from this repository's
# checkout at the workflow's own commit; no workflow writes the version again (scripts/workflows.test.ts). Nothing
# builds this file. Dependabot reads it (.github/dependabot.yml), here rather than under .github/, where its docker
# updates may not write, so its bump of this file is the whole change.
FROM ghcr.io/anchore/syft:v1.57.1@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060
