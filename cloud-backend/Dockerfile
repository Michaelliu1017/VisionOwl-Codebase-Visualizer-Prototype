FROM node:22.14-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY cloud-backend/package.json cloud-backend/package.json
COPY desktop/package.json desktop/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/graph-sanitizer/package.json packages/graph-sanitizer/package.json

RUN npm ci --omit=dev --workspace @visionowl/cloud-backend

FROM node:22.14-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=17800

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY cloud-backend/package.json cloud-backend/package.json
COPY cloud-backend/src cloud-backend/src
COPY cloud-backend/migrations cloud-backend/migrations
COPY packages/graph-sanitizer/package.json packages/graph-sanitizer/package.json
COPY packages/graph-sanitizer/src packages/graph-sanitizer/src

USER node

EXPOSE 17800

HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:17800/api/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "cloud-backend/src/server.js"]
