# The dev container: the same toolchain as a laptop, installed by mise from mise.toml and mise.lock.
FROM mcr.microsoft.com/devcontainers/base:3.0.12-noble@sha256:ec556aed93f62aa6d13fe72c5db09da4e29a7c9b87c568dbca0ee5717466926a

# mise from its GitHub release, at the version every workflow's mise-action pins (scripts/toolchain.test.ts holds them
# together), for the platform being built. Each SHA-256 is the release's SHASUMS256.txt line for that binary, which jdx
# signs (SHASUMS256.asc); a mise upgrade moves the version and both checksums here with the workflows'.
ARG MISE_VERSION=2026.10.17
ARG MISE_SHA256_AMD64=fe6dd17e68e09682b31d2e7bb7bb755d22636ac1af5d94621e300f2ca9e9fe8a
ARG MISE_SHA256_ARM64=e90904144ba4377c5fbe385f429830282c68f3b4f9c690bf6c5a2ae9b74a809b
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) platform=linux-x64; sha256="$MISE_SHA256_AMD64" ;; \
      arm64) platform=linux-arm64; sha256="$MISE_SHA256_ARM64" ;; \
      *) echo "no mise checksum for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' -o /tmp/mise \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-${platform}"; \
    echo "${sha256}  /tmp/mise" | sha256sum --check --strict; \
    install -m 0755 /tmp/mise /usr/local/bin/mise; \
    rm /tmp/mise; \
    mise --version

USER vscode
ENV PATH=/home/vscode/.local/share/mise/shims:$PATH
