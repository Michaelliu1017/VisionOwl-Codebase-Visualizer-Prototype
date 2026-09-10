ARG CONTROLLER_BASE_IMAGE=visionowl-skill-lab-runner:0.1.0

FROM ${CONTROLLER_BASE_IMAGE}

LABEL org.opencontainers.image.title="VisionOwl Skill Lab Controller" \
      org.opencontainers.image.description="One-shot Skill Lab orchestration and evaluation control plane" \
      org.opencontainers.image.version="0.1.0"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/opt/visionowl-skill-lab/src \
    PATH=/opt/visionowl-controller-venv/bin:$PATH \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple \
    HOME=/tmp/visionowl-controller-home \
    NO_COLOR=1

USER root

RUN sed -i -E 's|https?://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' \
      /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3-pip \
      python3-venv \
      util-linux \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/visionowl-skill-lab

COPY pyproject.toml README.md ./
COPY docker/controller/constraints.txt /tmp/visionowl-constraints.txt

RUN python3 -m venv /opt/visionowl-controller-venv \
 && python -m pip install --no-cache-dir --upgrade pip \
 && python -m pip install --no-cache-dir \
      --constraint /tmp/visionowl-constraints.txt \
      'httpx>=0.27,<1' \
      'redis>=5,<7' \
      'deepeval>=4,<5' \
      'openai>=1,<3' \
      'skillopt @ git+https://github.com/microsoft/SkillOpt.git@47fe269d75d3def79ffd90236261d26d84868ae5'

COPY src ./src

# Install the local package separately from third-party dependencies so source
# changes can reuse the expensive, network-dependent SkillOpt layer.
RUN python -m pip install --no-cache-dir --no-deps .

COPY contracts ./contracts
COPY scripts ./scripts
COPY tests ./tests

RUN mkdir -p /tmp/visionowl-controller-home \
             /tmp/visionowl-runner-home \
             /data/visionowl-skill-lab \
 && chown -R 10001:10001 /tmp/visionowl-runner-home \
 && chown -R 10001:10001 /tmp/visionowl-controller-home /opt/visionowl-skill-lab

USER root

CMD ["visionowl-skill-lab-worker"]
