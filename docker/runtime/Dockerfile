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
  iproute2 \
  iputils-ping \
  jq \
  less \
  nano \
  netcat-openbsd \
  nodejs \
  npm \
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
  && rm -rf /var/lib/apt/lists/*

CMD ["/bin/bash", "-lc", "trap : TERM INT; while sleep 3600; do :; done"]
