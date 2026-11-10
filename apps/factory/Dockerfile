# The factory image: the gateway, triage, the intake and the log watcher run from it, each as a command of the one
# CLI (`factory gateway`, `factory triage`, ...). Built from the repository root, so the workspace lockfile, the shared
# packages and the policy files are in reach:
#
#     docker build --file apps/factory/Dockerfile .
#
# It is TypeScript that Node runs as it is, with its production dependencies only, in the repository's own layout so
# that `policy/` is found where the code imports it. The probes and the crawler need a browser and run from
# Dockerfile.browser instead. The migrations are not here: the console's image applies them.

FROM node:24.22.2-alpine3.24@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS base
WORKDIR /repo
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/factory/package.json apps/factory/
COPY packages/events/package.json packages/events/
COPY packages/store/package.json packages/store/
COPY packages/triage/package.json packages/triage/

# The production dependencies, readable by the unprivileged runtime user and writable by root alone, set in the layer
# that installs them, so a change to the code alone writes none of them again.
FROM base AS deps
# No lifecycle scripts: the only one is the repository's own, which installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @software-factory/factory... \
  && chmod -R a+rX,go-w /repo

# The dependencies first, then the code over them, each copy a layer of its own, the code with the same modes.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:088a01637f22908632ba09018be2e0b516f2fa6f7869c191d29491139db43c78 AS runtime
COPY --from=deps /repo /repo
WORKDIR /repo
COPY --chmod=a+rX,go-w apps/factory/src apps/factory/src
COPY --chmod=a+rX,go-w packages/events/src packages/events/src
COPY --chmod=a+rX,go-w packages/store/src packages/store/src
COPY --chmod=a+rX,go-w packages/triage/src packages/triage/src
COPY --chmod=a+rX,go-w policy policy
WORKDIR /repo/apps/factory
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# A Deployment names the command: `--import ./src/telemetry.ts src/cli.ts gateway`. With none, the usage is printed.
CMD ["src/cli.ts"]
