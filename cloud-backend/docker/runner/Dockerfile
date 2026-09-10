# ── visionowl-runner：一次性分析容器（spec §7.1）────────────────────────
# 含 扫描器（阶段一）+ qodercli（阶段二）+ skills。
# 凭证绝不进镜像层，全部运行时 -e 注入。
#
# 构建上下文 = 仓库根（需要同时拷 cloud-backend/ 与 skills/）：
#   docker build -f cloud-backend/docker/runner/Dockerfile -t visionowl-runner:latest .
# ACR library/ 命名空间实测不可用（insufficient_scope），默认用本地已有短名镜像
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV npm_config_registry=https://registry.npmmirror.com
ENV PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY cloud-backend/package.json cloud-backend/package-lock.json cloud-backend/pnpm-lock.yaml ./
RUN npm install --global pnpm@11.20.0 --registry=https://registry.npmmirror.com \
 && pnpm config set registry https://registry.npmmirror.com \
 && pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmmirror.com
COPY cloud-backend/tsconfig.json ./
COPY cloud-backend/scripts ./scripts
COPY cloud-backend/src ./src
RUN pnpm run build && pnpm prune --prod

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
ENV npm_config_registry=https://registry.npmmirror.com
ENV PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV PNPM_HOME=/usr/local
ENV PATH=$PNPM_HOME/bin:$PATH
# deb.debian.org 在本 ECS 实测极慢（单包 >300s），改阿里云 Debian 镜像源
RUN sed -i -E 's|https?://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' \
      /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
# Corepack 默认访问 registry.npmjs.org，而 ECS 该出口不稳定；先从镜像源安装 pnpm。
RUN npm install --global pnpm@11.20.0 --registry=https://registry.npmmirror.com \
 && pnpm config set registry https://registry.npmmirror.com \
 && pnpm add --global @qoder-ai/qodercli --registry=https://registry.npmmirror.com

# skill 无敏感信息，可入镜像层（spec §7.1）
COPY skills/ /root/.qoder/skills/
# 扫描器 = 已编译的 dist（阶段一入口 dist/scanner/cli.js）
COPY --from=build /app/node_modules /opt/scanner/node_modules
COPY --from=build /app/dist /opt/scanner/dist
COPY cloud-backend/docker/runner/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/entrypoint.sh"]
