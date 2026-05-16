FROM debian:bookworm

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=1000
ARG DOCKER_GID=952

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    docker.io \
    make \
    pkg-config \
    procps \
    python3 \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${USER_GID}" "${USERNAME}" \
  && useradd --uid "${USER_UID}" --gid "${USER_GID}" --create-home --shell /bin/bash "${USERNAME}" \
  && if ! getent group "${DOCKER_GID}" >/dev/null; then groupadd --gid "${DOCKER_GID}" docker-host; fi \
  && usermod --append --groups "$(getent group "${DOCKER_GID}" | cut -d: -f1)" "${USERNAME}"
