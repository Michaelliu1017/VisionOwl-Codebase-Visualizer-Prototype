# VisionOwl Deployment Guide

[English](#english) · [中文](#中文)

## English

### 1. Requirements

- Desktop: macOS or Linux, Node.js 22, npm, and Git.
- Server: x86_64 Linux, Docker Engine, and Docker Compose v2.
- Services: PostgreSQL 16 and Redis 7; use OSS for production artifacts when possible.
- Capacity: `4 vCPU / 8 GiB` for serialized demos; `8 vCPU / 16 GiB` for concurrent analysis.
- Expose only SSH and the gateway. Keep databases, internal APIs, and Docker Socket private.

### 2. Desktop Client

Configure `app/.env.production`:

```dotenv
VITE_USE_MOCK=false
VITE_API_BASE=https://<your-domain>
```

```bash
cd app
npm ci
npm run dev:cloud
```

Use `npm run dev:mock` for a UI-only demo. Validate a release with `npm run typecheck && npm run build`.

### 3. Full Local Stack

```bash
docker run -d --name vo-pg \
  -e POSTGRES_USER=visionowl -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=visionowl -p 127.0.0.1:5432:5432 postgres:16-alpine
docker run -d --name vo-redis \
  -p 127.0.0.1:6379:6379 redis:7-alpine

cd cloud-backend
cp .env.example .env
npm ci
openssl rand -hex 32
```

Set these values in `cloud-backend/.env`:

```dotenv
PUBLIC_BASE_URL=http://127.0.0.1:17800
DATABASE_URL=postgres://visionowl:dev@127.0.0.1:5432/visionowl
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=<generated-random-value>
ANALYZER_MODE=local
ARTIFACT_STORAGE=local
ARTIFACTS_DIR=/tmp/visionowl-artifacts
WORKSPACE_DIR=/tmp/visionowl-workspace
```

Run the API and worker in separate terminals:

```bash
npm run migrate
npm run dev
```

```bash
cd cloud-backend
npm run dev:worker
```

Point the desktop client to `http://127.0.0.1:17800`. Verify with:

```bash
curl -fsS http://127.0.0.1:17800/api/health
```

Analyzer modes: `demo` for queue/UI smoke tests, `local` for deterministic scans, and `runner` for Docker/Qoder analysis.

### 4. Production on ECS

Use `/opt/vo/{cloud-backend,knowledge-generator,skill-lab,skills,infra}` for code and configuration, and `/data/{artifacts,workspace}` for runtime data. Never run `rsync --delete` against the entire `/opt/vo` tree.

```bash
mkdir -p /opt/vo/infra/nginx /data/artifacts /data/workspace
cp /opt/vo/cloud-backend/docker/compose.ecs.yaml /opt/vo/infra/compose.yaml
cp /opt/vo/cloud-backend/docker/nginx-visionowl-cloud.conf \
  /opt/vo/infra/nginx/visionowl-cloud.conf
cp /opt/vo/cloud-backend/.env.example /opt/vo/infra/.env
chmod 600 /opt/vo/infra/.env
```

Configure `/opt/vo/infra/.env` with strong values for:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and matching `DATABASE_URL`.
- `PUBLIC_BASE_URL`, `JWT_SECRET`, and optional `OSS_*` storage fields.
- `ANALYZER_MODE=runner`, `RUNNER_IMAGE`, and runtime-only `QODER_PERSONAL_ACCESS_TOKEN`.
- `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_PATH`, and `GITHUB_WEBHOOK_SECRET`.

Mount the GitHub App key as a read-only secret; never copy credentials into an image.

```bash
cd /opt/vo
docker network inspect runner-net >/dev/null 2>&1 || docker network create runner-net
docker build -f cloud-backend/docker/runner/Dockerfile \
  -t visionowl-runner:latest .

cd /opt/vo/infra
docker compose -p infra -f compose.yaml config
docker compose -p infra -f compose.yaml up -d --build
docker compose -p infra -f compose.yaml ps
```

The one-shot `migrate` service runs before the API. To enable optional modules, set the same `INTEGRATION_SERVICE_TOKEN` in Core and Skill Lab, and the same value as `CORE_SERVICE_TOKEN` in Knowledge Generator:

```bash
cd /opt/vo/knowledge-generator
cp .env.example .env
docker compose -p knowledge-generator -f deploy/compose.ecs.yaml up -d --build

cd /opt/vo/skill-lab
cp .env.example .env
docker build -f docker/runner/Dockerfile -t visionowl-skill-lab-runner:0.1.0 .
docker compose -p skill-lab -f deploy/compose.ecs.yaml up -d --build
```

Keep automatic knowledge generation and Skill optimization disabled until manual integration tests pass.

### 5. Endpoints, Verification, and Security

- Gateway: `https://<your-domain>` or `http://<ecs-ip>:8080` without TLS.
- Health: `GET /api/health`.
- GitHub App callback: `/api/github/app/callback`.
- GitHub webhook: `/webhook/github`; its secret must match `GITHUB_WEBHOOK_SECRET`.
- Nginx must disable buffering for SSE.

```bash
curl -fsS http://127.0.0.1:8080/api/health
docker compose -p infra -f /opt/vo/infra/compose.yaml ps
docker compose -p infra -f /opt/vo/infra/compose.yaml logs -f cloud worker gateway
```

Acceptance flow: create a project, bind a repository and branch, run the initial analysis, push a commit, confirm the incremental SSE update, then test agent chat and document generation.

Never commit `.env`, PATs, API keys, GitHub private keys, or DWS credentials. Back up PostgreSQL, `/opt/vo/infra/.env`, and artifact storage before upgrades, and keep versioned images for rollback.

## 中文

### 1. 环境要求

- 桌面端：macOS 或 Linux、Node.js 22、npm、Git。
- 云端：x86_64 Linux、Docker Engine、Docker Compose v2。
- 数据服务：PostgreSQL 16、Redis 7；生产产物优先使用 OSS。
- 资源：串行演示至少 `4 vCPU / 8 GiB`；并发分析建议 `8 vCPU / 16 GiB`。
- 公网只开放 SSH 与 Gateway；数据库、内部 API 和 Docker Socket 不得暴露公网。

### 2. 只运行桌面端

配置 `app/.env.production`：

```dotenv
VITE_USE_MOCK=false
VITE_API_BASE=https://<your-domain>
```

```bash
cd app
npm ci
npm run dev:cloud
```

仅体验界面可执行 `npm run dev:mock`；发布前执行 `npm run typecheck && npm run build`。

### 3. 本地完整联调

```bash
docker run -d --name vo-pg \
  -e POSTGRES_USER=visionowl -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=visionowl -p 127.0.0.1:5432:5432 postgres:16-alpine
docker run -d --name vo-redis \
  -p 127.0.0.1:6379:6379 redis:7-alpine

cd cloud-backend
cp .env.example .env
npm ci
openssl rand -hex 32
```

在 `cloud-backend/.env` 中配置：

```dotenv
PUBLIC_BASE_URL=http://127.0.0.1:17800
DATABASE_URL=postgres://visionowl:dev@127.0.0.1:5432/visionowl
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=<生成的随机值>
ANALYZER_MODE=local
ARTIFACT_STORAGE=local
ARTIFACTS_DIR=/tmp/visionowl-artifacts
WORKSPACE_DIR=/tmp/visionowl-workspace
```

分别启动 API 和 Worker：

```bash
npm run migrate
npm run dev
```

```bash
cd cloud-backend
npm run dev:worker
```

将桌面端指向 `http://127.0.0.1:17800`，并验证：

```bash
curl -fsS http://127.0.0.1:17800/api/health
```

分析模式：`demo` 用于队列和界面冒烟，`local` 用于确定性扫描，`runner` 用于 Docker/Qoder 完整分析。

### 4. ECS 生产部署

代码与配置使用 `/opt/vo/{cloud-backend,knowledge-generator,skill-lab,skills,infra}`，运行数据使用 `/data/{artifacts,workspace}`。不要对整个 `/opt/vo` 执行 `rsync --delete`。

```bash
mkdir -p /opt/vo/infra/nginx /data/artifacts /data/workspace
cp /opt/vo/cloud-backend/docker/compose.ecs.yaml /opt/vo/infra/compose.yaml
cp /opt/vo/cloud-backend/docker/nginx-visionowl-cloud.conf \
  /opt/vo/infra/nginx/visionowl-cloud.conf
cp /opt/vo/cloud-backend/.env.example /opt/vo/infra/.env
chmod 600 /opt/vo/infra/.env
```

在 `/opt/vo/infra/.env` 中配置强随机值：

- `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD` 及匹配的 `DATABASE_URL`。
- `PUBLIC_BASE_URL`、`JWT_SECRET` 和可选的 `OSS_*` 存储字段。
- `ANALYZER_MODE=runner`、`RUNNER_IMAGE` 和仅在运行时注入的 `QODER_PERSONAL_ACCESS_TOKEN`。
- `GITHUB_APP_ID`、`GITHUB_APP_SLUG`、`GITHUB_APP_PRIVATE_KEY_PATH` 和 `GITHUB_WEBHOOK_SECRET`。

GitHub App 私钥必须作为只读 Secret 挂载，不能复制进镜像。

```bash
cd /opt/vo
docker network inspect runner-net >/dev/null 2>&1 || docker network create runner-net
docker build -f cloud-backend/docker/runner/Dockerfile \
  -t visionowl-runner:latest .

cd /opt/vo/infra
docker compose -p infra -f compose.yaml config
docker compose -p infra -f compose.yaml up -d --build
docker compose -p infra -f compose.yaml ps
```

一次性 `migrate` 服务会在 API 前执行。启用可选模块时，Core 与 Skill Lab 使用相同的 `INTEGRATION_SERVICE_TOKEN`，Knowledge Generator 的 `CORE_SERVICE_TOKEN` 使用同一值：

```bash
cd /opt/vo/knowledge-generator
cp .env.example .env
docker compose -p knowledge-generator -f deploy/compose.ecs.yaml up -d --build

cd /opt/vo/skill-lab
cp .env.example .env
docker build -f docker/runner/Dockerfile -t visionowl-skill-lab-runner:0.1.0 .
docker compose -p skill-lab -f deploy/compose.ecs.yaml up -d --build
```

手工联调通过前，保持自动知识生成和 Skill 优化关闭。

### 5. 入口、验收与安全

- Gateway：`https://<your-domain>`；未配置 TLS 时使用 `http://<ecs-ip>:8080`。
- 健康检查：`GET /api/health`。
- GitHub App Callback：`/api/github/app/callback`。
- GitHub Webhook：`/webhook/github`，Secret 必须与 `GITHUB_WEBHOOK_SECRET` 一致。
- Nginx 必须关闭 SSE 缓冲。

```bash
curl -fsS http://127.0.0.1:8080/api/health
docker compose -p infra -f /opt/vo/infra/compose.yaml ps
docker compose -p infra -f /opt/vo/infra/compose.yaml logs -f cloud worker gateway
```

完整验收：创建 Project，绑定仓库和分支，完成首次分析，Push 一次提交，确认桌面端收到增量 SSE 更新，最后验证 Agent 问答和文档生成。

不得提交 `.env`、PAT、API Key、GitHub 私钥或 DWS 登录态。升级前备份 PostgreSQL、`/opt/vo/infra/.env` 和 Artifact Storage，并保留版本化镜像用于回滚。
