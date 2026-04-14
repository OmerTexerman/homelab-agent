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
  && npm install -g @anthropic-ai/claude-code @openai/codex \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

CMD ["/bin/bash", "-lc", "trap : TERM INT; while sleep 3600; do :; done"]
