ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE}

ARG QODERCLI_VERSION=1.1.16

LABEL org.opencontainers.image.title="VisionOwl Skill Lab Runner" \
      org.opencontainers.image.description="Ephemeral non-root Qoder and hidden-check runtime" \
      org.opencontainers.image.version="0.1.0"

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/tmp/visionowl-home \
    NO_COLOR=1 \
    VISIONOWL_SKILL_LAB=1

RUN sed -i -E 's|https?://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' \
      /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      g++ \
      git \
      make \
      python3 \
      python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global \
      "@qoder-ai/qodercli@${QODERCLI_VERSION}" \
      --registry=https://registry.npmmirror.com \
 && qodercli --version | grep -F "${QODERCLI_VERSION}"

RUN groupadd --gid 10001 visionowl \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin visionowl \
 && mkdir -p /workspace /run/visionowl /tmp/visionowl-home \
 && chown -R 10001:10001 /workspace /run/visionowl /tmp/visionowl-home

WORKDIR /workspace
USER 10001:10001

CMD ["qodercli", "--version"]
