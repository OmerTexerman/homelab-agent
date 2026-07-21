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

# FALLBACK provider CLIs only. The live CLIs come from the host's provider
# CLI store, bind-mounted at /runtime/provider-clis and resolved first on
# PATH; these baked copies (whatever docker/runtime/provider-versions.json
# said at build time) only serve containers whose store mount is missing.
# The manifest is deliberately excluded from the build-context fingerprint,
# so rewriting it does NOT rebuild this image — updates flow through the
# store's atomic `current` symlink flip instead.
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
