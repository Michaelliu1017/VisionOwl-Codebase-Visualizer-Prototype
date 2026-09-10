# VisionOwl Knowledge Generator

Knowledge Generator 是 VisionOwl 的独立工程知识沉淀模块。它既可以单独采集 GitHub 工程证据，也可以消费主模块发出的 `knowledge:tasks`，把冻结版本的代码图谱与 Commit、Pull Request、Review、Comment、CI 和文件变更关联起来，生成可追溯并可直接使用的 Wiki 与 Skills。

## 完整链路

```text
VisionOwl Core
  -> Redis Stream: knowledge:tasks
  -> Knowledge Worker 获取冻结 GraphVersion 与仓库 commit
  -> GitHub Collector 采集同一 commit 的工程证据
  -> Deterministic Linker 按 repository + commit + path 关联模块
  -> Deterministic/Qoder Semantic Analyzer 提炼规范、踩坑与 Skill
  -> Wiki / Skills / Manifest / traceability / ZIP
  -> Core Artifact API
  -> complete 回调创建并发布 KnowledgeAssetVersion
  -> 首版 Skill 直接发布；后续新版本进入 Skill Lab 评估优化
```

模块不导入主模块代码，不读取主模块数据库，也不直接访问主模块的对象存储。双方只通过 Redis 消息和带服务令牌的 HTTP 契约交互。

## 已实现能力

- GitHub Commit、PR、Review、Comment、Actions、Job 和文件变更采集。
- Evidence v1 标准化、Raw Record、确定性关系、pending link 与快照校验。
- File、Memory、PostgreSQL 三种独立 Evidence Store。
- 多仓库冻结 commit 采集，避免把最新分支证据串到历史图谱。
- 工程证据与代码模块的确定性关联，不使用标题相似度等弱关联。
- 确定性知识骨架；可选 Qoder 语义增强，失败时自动降级。
- Wiki、开发规范、踩坑指南、模块文档和 Skill 生成。
- 每条知识保留 Evidence ID、来源 URL、commit 和模块关联依据。
- Manifest、独立文件、ZIP Bundle、SHA-256 校验与主模块发布回调。
- Redis Consumer Group、ACK、Pending、`XAUTOCLAIM` 和优雅退出。
- 本地审计目录保存命令摘要、建联结果、语义结果和发布记录。

## 本地检查

```bash
cd /Users/liuguoliang/Documents/swe/alitest/knowledge-generator
npx --yes pnpm@11.16.0 install
npx --yes pnpm@11.16.0 check
```

测试完全使用固定 Fixture，不访问真实 GitHub 或 VisionOwl Core。集成测试会模拟 Core 命令、图谱下载、产物上传和完成回调。

## 单独采集公开仓库

建议在 `.env` 配置只读 `GITHUB_TOKEN`。匿名调用可用，但 GitHub 限额很低。

```bash
npx --yes pnpm@11.16.0 run sync -- \
  --repo https://github.com/fastify/fastify \
  --project-id standalone \
  --since 2026-01-01T00:00:00Z \
  --max-items 100 \
  --concurrency 3
```

默认输出：

- `data/store.json`：可重启的 Evidence Store。
- `data/snapshots/<repository-id>/evidence-graph-<hash>.json`：Evidence Graph 快照。

## 接入 VisionOwl 主模块

复制 `.env.example` 为 `.env`，至少配置：

```bash
KNOWLEDGE_WORKER_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379
CORE_BASE_URL=http://127.0.0.1:17800
CORE_SERVICE_TOKEN=<与主模块 INTEGRATION_SERVICE_TOKEN 相同>
GITHUB_TOKEN=<只读 GitHub Token>
KNOWLEDGE_SEMANTIC_PROVIDER=deterministic
```

启动独立 Worker：

```bash
npx --yes pnpm@11.16.0 run worker
```

也可以让 HTTP API 与 Worker 同进程启动：

```bash
KNOWLEDGE_WORKER_ENABLED=true npx --yes pnpm@11.16.0 start
```

手工处理一个 Core 已创建的任务：

```bash
npx --yes pnpm@11.16.0 run process-run -- --run-id <knowledge-run-id>
```

## 语义模式

- `deterministic`：默认。只根据代码图谱与结构化证据生成保守知识，不依赖模型。
- `qoder`：调用 `qodercli` 提炼规范、踩坑和 Skill；输出中的每条结论必须引用已知 Evidence ID。
- `KNOWLEDGE_SEMANTIC_REQUIRED=false`：Qoder 不可用时自动回退确定性模式。
- `KNOWLEDGE_SEMANTIC_REQUIRED=true`：Qoder 失败则整个任务失败，适用于严格验收环境。

Qoder 模式要求宿主机或自定义 Worker 镜像内已安装并登录 `qodercli`。默认 Docker 镜像使用确定性模式，不包含 Qoder CLI 或任何个人登录凭证。

## ECS Docker 部署

`deploy/compose.ecs.yaml` 会把 Worker 接入现有的 `infra_visionowl-private` 网络，使用网络内的 `redis:6379` 和 `cloud:17800`，不向公网暴露新端口。

```bash
cd /opt/vo/knowledge-generator
docker compose -p knowledge-generator -f deploy/compose.ecs.yaml up -d --build
docker compose -p knowledge-generator -f deploy/compose.ecs.yaml logs -f
```

首次联调建议限制采集范围：

```bash
KNOWLEDGE_HISTORY_DAYS=30
KNOWLEDGE_MAX_ITEMS=20
GITHUB_MAX_CONCURRENCY=2
KNOWLEDGE_REPOSITORY_CONCURRENCY=1
KNOWLEDGE_SEMANTIC_PROVIDER=deterministic
```

主模块同时需要启用 `KNOWLEDGE_INTEGRATION_ENABLED=true`，并确保其 `INTEGRATION_SERVICE_TOKEN` 与本模块的 `CORE_SERVICE_TOKEN` 完全相同。

## PostgreSQL 模式

```bash
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://user:password@host:5432/database
npx --yes pnpm@11.16.0 migrate
```

迁移只创建 `knowledge_generator` Schema，不读写 VisionOwl Core 的业务表。

## 可靠性语义

- Core 将 `runId` 和 `idempotencyKey` 写入 `knowledge:tasks`。
- Worker 使用 Consumer Group 消费；发布成功后 ACK。
- 业务生成失败且 `fail` 回调成功后 ACK，Core 负责记录最终失败状态。
- Core 暂时不可达时不 ACK；消息保留在 Pending List，超过 idle 时间后由 `XAUTOCLAIM` 重试。
- Core 只接受当前 run 目录下的产物，并重新校验 Bundle 与 Manifest 中每个文件的 SHA-256。

## 主要目录

- `src/github`、`src/sync`、`src/evidence`：GitHub Evidence 采集与标准化。
- `src/knowledge/linker.ts`：Evidence 到代码模块的确定性建联。
- `src/knowledge/semantic.ts`：确定性与 Qoder 语义提炼。
- `src/knowledge/generator.ts`：Wiki 与 Skill 文件生成。
- `src/knowledge/publisher.ts`：Manifest、ZIP、上传与 checksum。
- `src/knowledge/processor.ts`：单次知识任务状态机。
- `src/queue/knowledgeWorker.ts`：Redis Stream Worker。
- `contracts`：Evidence 和 Core Integration JSON 契约。
- `test`：Fixture、单元测试和端到端契约测试。
