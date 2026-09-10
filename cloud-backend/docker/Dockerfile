# ── VisionOwl Cloud（API + Worker 同镜像，不同入口）─────────────────────
# 网络红线（ECS 实测）：registry-1.docker.io 不通 → 基础镜像必须走 ACR；
#                      raw.githubusercontent.com 不通 → 任何安装脚本不得依赖；
#                      registry.npmmirror.com 可用 → npm 走镜像源。
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV npm_config_registry=https://registry.npmmirror.com
ENV PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json ./
COPY pnpm-lock.yaml ./
RUN npm install --global pnpm@11.20.0 --registry=https://registry.npmmirror.com \
 && pnpm config set registry https://registry.npmmirror.com \
 && pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmmirror.com
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
ENV npm_config_registry=https://registry.npmmirror.com
WORKDIR /app
# git:Worker 在 local 模式下需要克隆仓库;ca-certificates:HTTPS
# deb.debian.org 在本 ECS 上实测极慢(单包 >300s),改走阿里云 Debian 镜像源
RUN sed -i -E 's|https?://deb.debian.org|http://mirrors.cloud.aliyuncs.com|g' \
      /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates unzip \
 && npm install --global @qoder-ai/qodercli \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
# 凭证一律运行时注入，绝不写入镜像层（spec §12-1）
EXPOSE 17800
CMD ["node", "dist/index.js"]
