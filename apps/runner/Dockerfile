# The factory-runner image: what a runner's two pods run (`runner prepare`, `runner agent`). Built from the repository
# root, so the workspace lockfile is in reach:
#
#     docker build --file apps/runner/Dockerfile .
#
# It holds Node at the version the app pins, git, this repository's pnpm, and the Agent SDK. The app's own
# dependencies are not here: the prepare pod installs them onto the job's volume, from the app's lockfile.

FROM node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS base
# git, to check out the app and write the agent's patch. The Debian packages are the image's release's.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS release
# pnpm, at the version mise.lock holds for this platform, checked against its checksum there (scripts/install-pnpm.ts).
COPY mise.lock apps/runner/scripts/install-pnpm.ts /tmp/pnpm/
RUN node /tmp/pnpm/install-pnpm.ts /tmp/pnpm/mise.lock /opt/pnpm && chmod -R a+rX,go-w /opt/pnpm

FROM base AS node
# This repository's pnpm, the one `mise upgrade` moves, as pnpm's own executable, read-only: the runner's pods have no
# way to change it, and the agent pod, with no network, has no need to fetch one. Corepack is not enabled, so no shim
# of its stands in for pnpm and enforces a checkout's `packageManager`, and pnpm itself is told not to switch to the
# version that names: the app pins pnpm on its own, within the same major (src/prepare.ts says when the major differs).
COPY --from=release /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm
ENV npm_config_manage_package_manager_versions=false

# The Agent SDK and the runner's other production dependencies, readable by the unprivileged runtime user and
# writable by root alone, set in the layer that installs them, so a change to the code alone writes none of them again.
FROM node AS deps
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/runner/package.json apps/runner/
# No lifecycle scripts: the only one is the repository's own, which installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @software-factory/runner... \
  && chmod -R a+rX,go-w /repo

# The dependencies first, then the code over them, each copy a layer of its own, the code with the same modes.
FROM node AS runtime
COPY --from=deps /repo /repo
WORKDIR /repo
COPY --chmod=a+rX,go-w apps/runner/src apps/runner/src
# The skills a step can name, as a plugin the agent step loads (`plugin/README.md`).
COPY --chmod=a+rX,go-w apps/runner/plugin apps/runner/plugin
USER 65532:65532
# The job's volume is /work: the checkout, its dependencies and the agent's session.
ENV NODE_ENV=production WORK=/work HOME=/work/home
WORKDIR /work
ENTRYPOINT ["node", "/repo/apps/runner/src/cli.ts"]
