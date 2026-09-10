# VisionOwl Cloud（cloud-backend）

VisionOwl 云端服务：**Cloud API + Analysis Worker（同镜像不同入口）+ 一次性 Runner 容器**。
接口以 [协同开发.md](../协同开发.md) contract-v1.0 为准，产品与架构见 [spec.md](../spec.md)。

## 技术栈

Node.js 22 + TypeScript + Fastify 4 · pg（原生 SQL + 迁移文件）· ioredis · zod（入参）+ AJV（graph.json）
口令哈希用 Node 内置 `scrypt`（零原生依赖，避开 ECS 编译工具链问题）。

## 快速开始（本地）

```bash
cd cloud-backend
cp .env.example .env            # 至少改 DATABASE_URL / REDIS_URL / JWT_SECRET
npm install

# 起依赖（本地开发用，端口随意）
docker run -d --name vo-pg -e POSTGRES_USER=visionowl -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=visionowl -p 5432:5432 postgres:16-alpine
docker run -d --name vo-redis -p 6379:6379 redis:7-alpine

npm run migrate                 # 建表（幂等，已执行的迁移会跳过）
npm run seed                    # 落契约 §8 演示数据（幂等）
npm run dev                     # API :17800
npm run dev:worker              # 另开一个终端：Worker
```

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` / `dev:worker` | 开发模式（tsx watch） |
| `npm run build` | tsc 编译 + 拷 JSON 资源到 dist |
| `npm start` / `start:worker` | 生产入口（dist） |
| `npm run migrate` / `migrate:prod` | 执行 `migrations/*.sql` |

ECS Compose 通过一次性 `migrate` 服务在 Cloud API 启动前执行生产迁移；迁移失败时 API 不得启动，避免新代码读取旧表结构。

部署后运行 `bash docker/test-collaboration.sh`，验收 Owner 邀请、Editor 兑换、共享 Project 访问和权限边界。
| `npm run seed` / `seed:prod` | 落演示数据（可反复执行） |
| `npm run scan -- --repo <dir> --out <dir>` | 单独跑确定性扫描器 |
| `npm run verify:fixture` | 校验 demo 图谱（17 节点/31 边 + 路径真实存在） |
| `npm run check` | typecheck + 单测 + fixture 校验（提交前必跑） |

> `npm run check` 目前是 `typecheck + test + verify:fixture`；未引入 ESLint 以减小依赖体积与装机风险，
> 代码风格靠 `tsconfig` 的 strict 全开（含 `noUnusedLocals`、`noUncheckedIndexedAccess`）约束。

## 目录

```
cloud-backend/
├── migrations/001_init.sql     spec §10 全部表 + 索引
├── src/
│   ├── index.ts                Fastify 装配（插件→鉴权→错误→路由）
│   ├── config.ts               env 解析与校验
│   ├── migrate.ts              迁移执行器
│   ├── api/                    路由层：zod 校验 + 调 service（不写 SQL）
│   ├── services/               业务逻辑（不感知 HTTP）
│   ├── infra/                  pg · redis · artifacts · githubApp
│   ├── realtime/sseHub.ts      SSE 分发（Redis pub/sub 作背板）
│   ├── webhook/github.ts       原始 body HMAC 验签 + 幂等 + 入队
│   ├── worker/                 队列消费 + 三种分析模式
│   ├── scanner/                确定性扫描器（阶段一，零 credit）
│   ├── schemas/                graph.schema.json + zod 请求 schema
│   └── seed/                   seed.ts + graph.demo.json（权威 demo 数据）
└── docker/                     Dockerfile · runner/ · compose.patch.md
```

分层铁律：`api` 不写 SQL；`services` 不感知 HTTP；`infra` 不含业务逻辑。

## 分析模式（ANALYZER_MODE）

| 模式 | 依赖 | 说明 |
|---|---|---|
| `demo` | 无 | 不克隆仓库，复用 seed 演示图谱，用于验证队列→版本→SSE 全链路 |
| `local` | git | 宿主机克隆 + 确定性扫描（零 credit）。设 `LOCAL_REPO_PATH` 可直接分析本地目录 |
| `runner` | ACR + docker + qodercli PAT | 完整两段式：Runner 容器内 扫描 + Agent 语义增强 |

本地实测（`local` 模式扫 `test/` EventHub fixture）：**14 模块 / 106 文件 → 16 节点 / 42 边**，
每条边都带真实 `file:line` 证据，`inferredCount=0`（确定性扫描永不推断）。

## 已实现的契约端点

Auth（register/login/me/logout）· Project（列表/创建/详情/PATCH）· 邀请（生成/列表/撤销/redeem）·
成员（列表/改角色/移除）· 仓库（install-url/callback/绑定）· 任务（触发/列表/详情）·
图谱（current/versions/单版本/artifact 直出）· 文档（CRUD + revisions）· 批注（CRUD）·
Chat（SSE 流）· 事件（SSE）· Health · `POST /webhook/github`

契约外的向后兼容加法（不破坏客户端）：`GET /api/health/deps`、`GET /api/github/app/status`、
`POST /api/auth/logout`、`POST /jobs` 支持可选 `targetCommitSha`。

## 安全约定（spec §12）

- 凭证只在内存流转：GitHub Installation Token 每任务现签（1h）、Qoder PAT 只给 Worker/Runner，
  **不入库、不入日志、不进镜像层**；日志对 `authorization` / `x-hub-signature-256` 做 redact，
  Runner 输出统一 scrub token 样式串。
- 默认拒绝鉴权：白名单仅 `health` / `register` / `login` / `webhook` / GitHub 安装回调。
- 非成员访问一律 404（防枚举），角色不足 403；敏感操作写 `audit_logs`。
- 邀请密钥只存 sha256 哈希，明文仅创建时返回一次。
- artifact 读写做路径穿越校验，只允许 `[A-Za-z0-9._-]` 片段。
- graph.json 视为不可信输入：AJV + 语义规则双校验，摘要打码，evidence ≤ 40 行。

## 联调给桌面端的三件事

1. BaseURL：`http://<ECS 公网 IP>:8080`，全部接口 `/api/...`，SSE 支持 `?token=<jwt>`。
2. 账号：`owner@demo.dev` / `editor@demo.dev`，口令 `demo1234`。
3. **fixture 同源**：把 `src/seed/graph.demo.json` 逐字节复制到
   `app/frontend/src/mock/fixtures/graph.demo.json`（本仓库的 Cloud Agent 不改 `app/`），
   用 `shasum -a 256` 比对两份一致后再联调。

## 部署

见 [docker/compose.patch.md](docker/compose.patch.md)：如何并入 ECS 现有 `infra` 栈
（新增 redis、gateway 放开 `0.0.0.0:8080`、挂 `/data/artifacts`），以及 nginx 对 SSE 必须
`proxy_buffering off`。
