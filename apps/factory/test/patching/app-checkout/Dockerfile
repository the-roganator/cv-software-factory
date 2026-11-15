# The shop's image: the server, its files and the catalogue database, which is built here and never written again.
#
#     docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) .

FROM node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
# pnpm at the version (and hash) pinned in package.json's packageManager field.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No scripts: the only one is `prepare`, which installs git hooks.
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
