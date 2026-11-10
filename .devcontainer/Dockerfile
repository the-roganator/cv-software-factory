# The dev container: the same toolchain as a laptop, installed by mise from mise.toml and mise.lock.
FROM mcr.microsoft.com/devcontainers/base:3.0.12-noble@sha256:ec556aed93f62aa6d13fe72c5db09da4e29a7c9b87c568dbca0ee5717466926a

# mise from its signed apt repository.
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://mise.jdx.dev/gpg-key.pub | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg] https://mise.jdx.dev/deb stable main" > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && apt-get install --yes --no-install-recommends mise \
 && rm -rf /var/lib/apt/lists/*

USER vscode
ENV PATH=/home/vscode/.local/share/mise/shims:$PATH
