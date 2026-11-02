# The factory image: the gateway, triage, the intake and the log watcher run from it, each as a command of the one
# CLI (`factory gateway`, `factory triage`, ...). Built from the repository root, so the workspace lockfile, the shared
# packages and the policy files are in reach:
#
#     docker build --file apps/factory/Dockerfile .
#
# It is TypeScript that Node runs as it is, with its production dependencies only, in the repository's own layout so
# that `policy/` is found where the code imports it. The probes and the crawler need a browser and run from
# Dockerfile.browser instead. The migrations are not here: the console's image applies them.

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
WORKDIR /repo
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/factory/package.json apps/factory/
COPY packages/events/package.json packages/events/
COPY packages/store/package.json packages/store/
COPY packages/triage/package.json packages/triage/

# The production dependencies, made readable by the unprivileged runtime user and by nobody's writes in the same
# layer, so a change to the code alone writes none of them again.
FROM base AS deps
# No lifecycle scripts: the only one is the repository's own, which installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @software-factory/factory... \
  && chmod -R a+rX,go-w /repo

# The dependencies first, then the code over them, each copy a layer of its own, the code with the same modes.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8 AS runtime
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
