# The dev container: the same toolchain as a laptop, installed by mise at the versions mise.lock holds.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# mise from its signed apt repository.
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://mise.jdx.dev/gpg-key.pub | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg] https://mise.jdx.dev/deb stable main" > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && apt-get install --yes --no-install-recommends mise \
 && rm -rf /var/lib/apt/lists/*

USER vscode
ENV PATH=/home/vscode/.local/share/mise/shims:$PATH
