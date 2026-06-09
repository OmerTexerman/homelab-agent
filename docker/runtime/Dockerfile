FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  coreutils \
  curl \
  dnsutils \
  docker.io \
  git \
  gnupg \
  iproute2 \
  iputils-ping \
  jq \
  less \
  nano \
  netcat-openbsd \
  openssh-client \
  procps \
  python3 \
  python3-pip \
  python3-venv \
  ripgrep \
  rsync \
  tar \
  unzip \
  vim-tiny \
  wget \
  zip \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update && apt-get install -y --no-install-recommends \
  nodejs \
  && rm -rf /var/lib/apt/lists/*

# Provider CLI versions are pinned by a single source of truth that the host
# shares with this image: docker/runtime/provider-versions.json. The host
# update flow rewrites this file with the version it just installed, which
# changes the build-context fingerprint and triggers a rebuild so the image
# and host stay on the same versions. Keep this COPY + install in their own
# layer so version bumps don't bust the (slow) apt/node layer above.
COPY provider-versions.json /opt/homelab/provider-versions.json

RUN set -eux; \
  CLAUDE_CODE_VERSION="$(jq -er '."@anthropic-ai/claude-code"' /opt/homelab/provider-versions.json)"; \
  CODEX_CLI_VERSION="$(jq -er '."@openai/codex"' /opt/homelab/provider-versions.json)"; \
  OPENCODE_CLI_VERSION="$(jq -er '."opencode-ai"' /opt/homelab/provider-versions.json)"; \
  npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_CLI_VERSION}" \
    "opencode-ai@${OPENCODE_CLI_VERSION}"; \
  npm cache clean --force

CMD ["/bin/bash", "-lc", "trap : TERM INT; while sleep 3600; do :; done"]
