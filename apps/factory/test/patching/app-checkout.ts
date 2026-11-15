/**
 * The app's repository as the path's test checks it out (path.ts): its pins' files as they are in
 * `the-roganator/cv-worlds-worst-website`, each whole, and a small invented `package.json` and `pnpm-lock.yaml`. To
 * refresh one, copy it from the app's `main` again; the test names the pins it expects to find. Text here and no
 * files, so that nothing that reads this repository's own pins (scripts/ci-images.sh, scripts/image-pins.test.ts)
 * takes the app's for one of them: the build stage's image is written apart from its `FROM` for the same reason.
 */

/** The build stage's image, as the app's Dockerfile pins it. */
export const NODE_IMAGE =
  'node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85';

export const FILES: Record<string, string> = {
  '.devcontainer/Dockerfile': `# The dev container: the same toolchain as a laptop, installed by mise at the versions mise.lock holds.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# mise from its signed apt repository.
RUN install -d -m 0755 /etc/apt/keyrings \\
 && curl -fsSL https://mise.jdx.dev/gpg-key.pub | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \\
 && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg] https://mise.jdx.dev/deb stable main" > /etc/apt/sources.list.d/mise.list \\
 && apt-get update \\
 && apt-get install --yes --no-install-recommends mise \\
 && rm -rf /var/lib/apt/lists/*

USER vscode
ENV PATH=/home/vscode/.local/share/mise/shims:$PATH
`,
  '.github/CODEOWNERS': `# The rules are human-owned: what runs in CI, what is deployed, what may be installed, and how the shop talks.

/.github/                    @mrogan
/deploy/                     @mrogan
/Dockerfile                  @mrogan
/.dockerignore               @mrogan
/pnpm-workspace.yaml         @mrogan
/release-please-config.json  @mrogan

# Gate configuration
/Makefile                    @mrogan
/mise.toml                   @mrogan
/mise.lock                   @mrogan
/lefthook.yml                @mrogan
/biome.json                  @mrogan
/tsconfig.json               @mrogan
/vitest.config.ts            @mrogan
/scripts/commit-msg.ts       @mrogan

# The flag context: it reads the mark, checks the share's signature and names the preview, and is the only code that
# may ask OpenFeature (biome.json)
/src/flags/                  @mrogan

# Intent
/AGENTS.md                   @mrogan
/docs/BRIEF.md               @mrogan
/docs/REVIEWERS.md           @mrogan
/SECURITY.md                 @mrogan
/LICENSE                     @mrogan
`,
  '.github/dependabot.yml': `# Weekly dependency updates, each as a pull request through the same checks as any other change.
# The cooldown waits a few days after a release before proposing it: most malicious releases are pulled within hours.
version: 2

updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      # Node's own types follow the Node version in mise.toml, which moves by hand.
      - dependency-name: '@types/node'
        update-types: [version-update:semver-major]
      # 2.1.15 was published without provenance (2.1.14 and 2.1.16 have it), so pnpm's trust policy refuses it and
      # fails the whole update. Remove once lefthook 2.1.16 or later is merged.
      - dependency-name: lefthook
        versions: ['2.1.15']
    cooldown:
      default-days: 3
    commit-message:
      prefix: chore
      include: scope
    groups:
      opentelemetry:
        patterns: ['@opentelemetry/*']
      tooling:
        dependency-type: development

  # Includes the commit at which Software Factory's shared workflows are called.
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 3
    commit-message:
      prefix: ci
    groups:
      actions:
        patterns: ['*']

  - package-ecosystem: docker
    directories:
      - /
      - /.devcontainer
      # Syft, which build.yml attests SBOMs with, by version and digest (deploy/images/syft/Dockerfile). GHCR gives its
      # image no release date, so the cooldown holds for it only once GHCR does.
      - /deploy/images/syft
    schedule:
      interval: weekly
    ignore:
      # Both stages' Node match mise.toml's (test/node-pins.test.ts, and check.yml runs each), so a bump of either moves the
      # other, mise.toml and mise.lock by hand in the same pull request. A new major is a decision, not a weekly bump.
      - dependency-name: node
        update-types: [version-update:semver-major]
    cooldown:
      default-days: 3
    commit-message:
      prefix: chore
      include: scope

  - package-ecosystem: devcontainers
    directory: /
    schedule:
      interval: weekly
    commit-message:
      prefix: chore
      include: scope
`,
  Dockerfile: `# The shop's image: the server, its files and the catalogue database, which is built here and never written again.
#
#     docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) .

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No scripts: the only one is \`prepare\`, which installs git hooks.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY src src
COPY public public
COPY scripts/seed.ts scripts/
COPY data/catalogue.json data/
RUN node scripts/seed.ts
# Readable by the unprivileged runtime user, and by nobody's writes.
RUN chmod -R a+rX,go-w /app

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba
COPY --from=build /app /app
WORKDIR /app
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["--import", "./src/telemetry.ts", "src/server.ts"]
`,
  'deploy/images/syft/Dockerfile': `# Syft's one pin: build.yml's signing job attests each image's SBOMs with Syft at this version, read from here, from the
# workflow's own commit. No workflow writes the version again (test/syft-pin.test.ts). Nothing builds this file.
# Dependabot reads it (.github/dependabot.yml), here rather than under .github/, where its docker updates may not write,
# so its bump of this file is the whole change, and its merge builds and signs with the new Syft (build.yml's paths).
FROM ghcr.io/anchore/syft:v1.57.1@sha256:03215d0e98b661d0ecbc8575dbc14d65be1743b5de5df6410aecb7e80f95b060
`,
  'mise.lock': `# @generated - this file is auto-generated by \`mise lock\` https://mise.jdx.dev/dev-tools/mise-lock.html

lockfile_version = 3

[[tools.kustomize]]
version = "5.8.3"
backend = "aqua:kubernetes-sigs/kustomize"
specifiers = ["5"]

[tools.kustomize."platforms.linux-arm64"]
checksum = "sha256:9867b76482cfc6d25b546abc1d2b5a32bd137505aba640649b4b378f64f6d68f"
checksum_source = "mise-versions"
url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.3/kustomize_v5.8.3_linux_arm64.tar.gz"
url_api = "https://api.github.com/repos/kubernetes-sigs/kustomize/releases/assets/621661325"

[tools.kustomize."platforms.linux-x64"]
checksum = "sha256:cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61"
checksum_source = "mise-versions"
url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.3/kustomize_v5.8.3_linux_amd64.tar.gz"
url_api = "https://api.github.com/repos/kubernetes-sigs/kustomize/releases/assets/621661332"

[tools.kustomize."platforms.macos-arm64"]
checksum = "sha256:4cbb08e209d8fff47cd60bfb6407daaf5ee699f9b9295849a1065024fac2d1ef"
checksum_source = "mise-versions"
url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.3/kustomize_v5.8.3_darwin_arm64.tar.gz"
url_api = "https://api.github.com/repos/kubernetes-sigs/kustomize/releases/assets/621661327"

[tools.kustomize."platforms.macos-x64"]
checksum = "sha256:d08fb85846c3d977f0e2a66e7ff45f1b5264c294685e5e726e1a8bdfe0da8dee"
checksum_source = "mise-versions"
url = "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize/v5.8.3/kustomize_v5.8.3_darwin_amd64.tar.gz"
url_api = "https://api.github.com/repos/kubernetes-sigs/kustomize/releases/assets/621661334"

[[tools.node]]
version = "24.22.2"
backend = "core:node"
specifiers = ["24.22.2"]

[tools.node."platforms.linux-arm64"]
checksum = "sha256:95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2"
url = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-arm64.tar.gz"

[tools.node."platforms.linux-x64"]
checksum = "sha256:361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9"
url = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz"

[tools.node."platforms.macos-arm64"]
checksum = "sha256:aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a"
url = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz"

[tools.node."platforms.macos-x64"]
checksum = "sha256:d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52"
url = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-x64.tar.gz"

[[tools.pnpm]]
version = "12.16.1"
backend = "aqua:pnpm/pnpm"
specifiers = ["12"]

[tools.pnpm."platforms.linux-arm64"]
checksum = "sha256:f5847699e5d528f8f8e9bcfb385e58cb9fba7482af1b1aa7b70737be42277f81"
url = "https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-linux-arm64.tar.gz"
url_api = "https://api.github.com/repos/pnpm/pnpm/releases/assets/681916052"
provenance = "github-attestations"

[tools.pnpm."platforms.linux-x64"]
checksum = "sha256:565ff81174a14f6f7bd5d84c1b17e51031a80230d370a1fe24be5d16bd02a825"
url = "https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-linux-x64.tar.gz"
url_api = "https://api.github.com/repos/pnpm/pnpm/releases/assets/681916059"
provenance = "github-attestations"

[tools.pnpm."platforms.macos-arm64"]
checksum = "sha256:6661212a6ec725634b0d3268e5bc9408e3152506dab5997891e38fa1ef22bf9c"
url = "https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-darwin-arm64.tar.gz"
url_api = "https://api.github.com/repos/pnpm/pnpm/releases/assets/681916062"
provenance = "github-attestations"

[tools.pnpm."platforms.macos-x64"]
checksum = "sha256:f2c52f20f631a31011a6e33e3812d136db89c4a5c1d23123b92cbe62ecec82a6"
url = "https://github.com/pnpm/pnpm/releases/download/v12.16.1/pnpm-darwin-x64.tar.gz"
url_api = "https://api.github.com/repos/pnpm/pnpm/releases/assets/681916060"
provenance = "github-attestations"
`,
  'mise.toml': `# The whole toolchain: \`mise install\` sets up a laptop, and CI and the dev container use the same file. Each tool names
# the releases it may move within, and mise.lock holds the exact version of each, with the checksum of its download for
# each platform below, so every install is the same until someone upgrades. To upgrade, \`mise upgrade\` (within these
# ranges; \`--bump\` past them) and a \`chore(toolchain)\` pull request with both files; Dependabot does not read mise.
[settings]
lockfile = true
# A Mac (Apple Silicon or Intel), CI's runners, and the dev container on either kind of host.
lockfile_platforms = ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"]
# \`mise upgrade\` takes a release only once it is three days old, as Dependabot's cooldown does.
minimum_release_age = "3d"

[tools]
# Exact: the Node both of the Dockerfile's stages run, which test/node-pins.test.ts and check.yml hold them to.
node = "24.22.2"
# The one package.json's packageManager names (test/toolchain.test.ts holds them together).
pnpm = "12"
kustomize = "5"
`,
  'package.json': `{
  "name": "shop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "example-direct": "^1.0.0",
    "example-parent": "^4.0.0"
  }
}
`,
  'pnpm-lock.yaml': `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      example-direct:
        specifier: ^1.0.0
        version: 1.0.0
      example-parent:
        specifier: ^4.0.0
        version: 4.0.0

packages:

  example-direct@1.0.0:
    resolution: {integrity: sha512-direct}

  example-indirect@3.2.0:
    resolution: {integrity: sha512-indirect}

  example-old@2.0.0:
    resolution: {integrity: sha512-old}

  example-parent@4.0.0:
    resolution: {integrity: sha512-parent}

  example-twice@6.11.0:
    resolution: {integrity: sha512-twice6}

  example-twice@7.6.4:
    resolution: {integrity: sha512-twice7}

snapshots:

  example-direct@1.0.0: {}

  example-indirect@3.2.0: {}

  example-old@2.0.0:
    dependencies:
      example-twice: 6.11.0

  example-parent@4.0.0:
    dependencies:
      example-indirect: 3.2.0
      example-old: 2.0.0
      example-twice: 7.6.4

  example-twice@6.11.0: {}

  example-twice@7.6.4: {}
`,
  'pnpm-workspace.yaml': `# Supply chain. pnpm already waits a day before installing a new release (minimumReleaseAge) and runs no
# dependency's install scripts unless allowed here.
trustPolicy: no-downgrade # refuse a release published with weaker provenance than the one before it
trustPolicyExclude:
  # Published by the same maintainer without provenance in January 2025, after two releases with it; used by Vitest.
  - why-is-node-running@3.2.2
allowBuilds:
  lefthook: false # its postinstall only installs the git hooks, which \`prepare\` does
  protobufjs: false # its postinstall only prints a version-scheme warning
`,
};
