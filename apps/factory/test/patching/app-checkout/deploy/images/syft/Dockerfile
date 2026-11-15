# Syft's one pin: build.yml's signing job attests each image's SBOMs with Syft at this version, read from here, from the
# workflow's own commit. No workflow writes the version again (test/syft-pin.test.ts). Nothing builds this file.
# Dependabot reads it (.github/dependabot.yml), here rather than under .github/, where its docker updates may not write,
# so its bump of this file is the whole change, and its merge builds and signs with the new Syft (build.yml's paths).
FROM ghcr.io/anchore/syft:v1.54.0@sha256:0356562f495d432056237fbea5cbc2d4839c9c75cd500784a66de2e7cc95ca7c
