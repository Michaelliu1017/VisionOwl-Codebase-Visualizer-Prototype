ARG NODE_IMAGE=node:22.14-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV npm_config_registry=https://registry.npmmirror.com
ENV PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.16.0 --registry=https://registry.npmmirror.com \
 && pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmmirror.com
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV npm_config_registry=https://registry.npmmirror.com
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["node", "dist/src/worker.js"]
