# The console image. Built from the repository root, so the workspace lockfile, the shared packages and the
# design system are in reach:
#
#     docker build --file apps/console/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
#
# The browser code is built in one stage and the server's production dependencies installed in another; the
# runtime image takes the output of both, and keeps the repository's layout, so the server finds its files
# where it does in development. The migration Job runs this image too.

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base
WORKDIR /repo
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json apps/console/
COPY packages/events/package.json packages/events/
COPY packages/store/package.json packages/store/
# The rules of the line, a package the browser code imports by name.
COPY policy/package.json policy/

# The browser code, built by Vite into apps/console/dist.
FROM base AS web
# No lifecycle scripts: the only one is the repository's own, which installs git hooks.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @software-factory/console...
# Vite reads the compiler options web/tsconfig.json extends.
COPY tsconfig.base.json ./
COPY apps/console/vite.config.ts apps/console/
COPY apps/console/web apps/console/web
COPY packages/events/src packages/events/src
# The bounds of Martin's settings and of the line's controls, and the one check of each (policy/settings.ts,
# policy/line.ts), which the page shares with the line and the admin service, and the settings with the gateway;
# whether alerts reach Martin's phone (policy/phone.ts), which it shares with the admin service; and the feature
# flags' stages and the rules of moving one (policy/flags.ts, policy/flag-moves.ts), which the page judges each stop
# of a flag's slider by, in the admin service's own words.
COPY policy/models.ts policy/spend.ts policy/settings.ts policy/line.ts policy/phone.ts policy/flags.ts policy/flag-moves.ts policy/
COPY docs/design/system/properties.css docs/design/system/station.ts docs/design/system/
COPY docs/design/system/mark/icon.svg docs/design/system/mark/
ARG GIT_COMMIT=unknown
RUN GIT_COMMIT=$GIT_COMMIT pnpm --filter @software-factory/console build

# The server: TypeScript that Node runs as it is, and its production dependencies only.
FROM base AS server
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter @software-factory/console...
COPY apps/console/src apps/console/src
COPY packages/events/src packages/events/src
COPY packages/store/src packages/store/src
COPY packages/store/migrations packages/store/migrations
# Who may do what (policy/access.ts), which the server enforces, Martin's roles in the store (store-grants.ts), and the
# profiles and their models (spend.ts, models.ts), one of which the server tells the page.
COPY policy/access.ts policy/store-grants.ts policy/spend.ts policy/models.ts policy/
COPY --from=web /repo/apps/console/dist apps/console/dist
# Readable by the unprivileged runtime user, and by nobody's writes.
RUN chmod -R a+rX,go-w /repo

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8
COPY --from=server /repo /repo
WORKDIR /repo/apps/console
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["--import", "./src/telemetry.ts", "src/server.ts"]
