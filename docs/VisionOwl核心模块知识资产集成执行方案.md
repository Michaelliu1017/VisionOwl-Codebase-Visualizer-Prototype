# VisionOwl 核心模块知识资产集成执行方案

## 1. 目标

升级现有 VisionOwl Core，使其可以稳定编排两个独立模块：

- Knowledge Generator：根据指定图谱版本和仓库快照生成 Wiki 与候选 Skill。
- Skill Lab：评估、优化候选 Skill，输出分数、报告、修改差异和可发布版本。

Core 负责权限、状态、版本、任务编排和结果发布；两个扩展模块负责计算，不直接修改 Core 数据库。现有代码扫描、图谱、Chat、文档和多人协作链路保持兼容。

### 1.1 兼容运行模式

- 默认 `KNOWLEDGE_INTEGRATION_ENABLED=false`，Core 不注册扩展路由、不启动扩展定时任务，也不要求集成令牌。
- 扩展关闭或旧后端没有新接口时，Electron 只把工程知识资产面板降级为“未接入”，不得阻断 Project、图谱、Chat、文档和批注加载。
- 只有完成数据库迁移并部署两个消费者后，才设置 `KNOWLEDGE_INTEGRATION_ENABLED=true` 和 `INTEGRATION_SERVICE_TOKEN`。
- Knowledge Generator 或 Skill Lab 临时离线时，只影响对应任务；上一版资产和 Core 原有功能继续可用。

## 2. 目标架构

| 组件 | 主要职责 | 数据边界 |
| --- | --- | --- |
| Electron | 展示资产状态、目录、预览、下载和运行进度 | 只访问 Core REST API 与 SSE |
| VisionOwl Core | 创建任务、鉴权、维护版本、发布结果、发送通知 | PostgreSQL 是元数据与状态的唯一真相 |
| Knowledge Generator | 读取固定版本的图谱与源码快照，生成 Wiki 和候选 Skill | 只消费任务、上传产物、回调结果 |
| Skill Lab | 评估并优化候选 Skill | 只消费任务、上传报告与候选版本、回调结果 |
| Redis | 承载任务命令、幂等锁和 SSE 事件背板 | 不保存长期业务真相 |
| OSS | 保存 Wiki、Skill、目录清单、评测报告和 Diff 等大产物 | PostgreSQL 只保存引用、校验和与版本信息 |

主链路：图谱版本发布 → Core 创建知识生成任务 → Knowledge Generator 发布 Wiki 与候选 Skill → Core 创建 Skill Lab 任务 → Skill Lab 返回评测结果和优化版本 → Core 切换有效版本 → SSE 通知 Electron 刷新。

## 3. 接口契约

第一步新增 Knowledge Integration Contract v1，并冻结以下内容后再并行开发三个模块。

### 3.1 Core 发出的任务

Knowledge Generator 任务至少包含：

- schemaVersion、commandId、runId、projectId。
- graphVersionId、graphArtifactKey。
- repositorySnapshots：每个仓库的 bindingId、仓库名、分支和 commit SHA。
- requestedAssets：wiki、skills。
- callbackTokenRef、deadline、idempotencyKey。

Skill Lab 任务至少包含：

- schemaVersion、commandId、runId、projectId。
- inputSkillVersionId、skillArtifactKey。
- evaluationDatasetRef、baselineVersionId。
- 优化约束：最大轮数、每轮最多修改二至三处、接受阈值。
- callbackTokenRef、deadline、idempotencyKey。

Redis 消息只携带 runId、projectId 和幂等键；消费者再通过受服务令牌保护的 command 接口取得完整命令。任务中禁止出现本机绝对路径、数据库凭证和长期云凭证。源码及产物由 Core 的内部下载接口代理，扩展模块不接触 OSS 长期凭证。

### 3.2 扩展模块回调 Core

新增内部接口：

- POST /internal/v1/knowledge-runs/{runId}/progress
- POST /internal/v1/knowledge-runs/{runId}/complete
- POST /internal/v1/knowledge-runs/{runId}/fail
- POST /internal/v1/skilllab-runs/{runId}/progress
- POST /internal/v1/skilllab-runs/{runId}/complete
- POST /internal/v1/skilllab-runs/{runId}/fail
- GET /internal/v1/knowledge-runs/{runId}/command
- GET /internal/v1/knowledge-runs/{runId}/input/graph
- GET /internal/v1/skilllab-runs/{runId}/command
- GET /internal/v1/skilllab-runs/{runId}/input/skill
- PUT /internal/v1/integration-runs/{runId}/artifacts/{fileName}

完成回调只提交产物引用、checksum、版本来源、摘要和质量结果，不直接提交任意数据库字段。Core 校验任务归属、状态、Schema、checksum 和幂等键后才能发布。

### 3.3 Electron 访问 Core

新增公开接口：

- GET /api/projects/{projectId}/knowledge-assets：读取 Wiki 与 Skill 当前状态和版本。
- GET /api/projects/{projectId}/knowledge-assets/{assetId}/versions：读取历史版本。
- GET /api/projects/{projectId}/knowledge-assets/{assetId}/tree：读取目录。
- GET /api/projects/{projectId}/knowledge-assets/{assetId}/content：预览单个文件。
- GET /api/projects/{projectId}/knowledge-assets/{assetId}/download：下载当前资产包。
- POST /api/projects/{projectId}/knowledge-runs：手动重新生成。
- GET /api/projects/{projectId}/knowledge-runs/{runId}：读取执行进度与错误。
- GET /api/projects/{projectId}/skilllab-runs/{runId}：读取分数、Diff 和评测摘要。

Owner 与 Editor 均可查看、下载和触发生成，沿用现有规则：两者唯一权限差异仍是 Owner 可以删除 Project。

## 4. Core 数据模型升级

新增迁移文件，建立四张核心表：

| 表 | 用途 |
| --- | --- |
| knowledge_assets | Project 下 Wiki、Skill 的稳定身份和当前有效版本 |
| knowledge_asset_versions | 只追加的资产版本，记录来源图谱、仓库 commit 集、OSS 引用、checksum、状态和质量摘要 |
| knowledge_generation_runs | Knowledge Generator 任务状态、幂等键、输入图谱、输出版本与错误 |
| skill_evaluation_runs | Skill Lab 的输入版本、基线、候选版本、分数、报告、Diff 和接受结果 |

状态约定：

- 资产：pending、generating、ready、updating、failed、stale。
- Knowledge Run：queued、running、publishing、succeeded、failed、canceled。
- Skill Lab Run：queued、evaluating、optimizing、validating、succeeded、rejected、failed。

任何失败都不得覆盖当前有效版本。新版本只有通过 Core 校验并原子切换后才对用户可见。

## 5. Core 业务逻辑

### 5.1 自动生成

1. 新 GraphVersion 成功发布后，Core 固定 graphVersionId 与多仓库 commit 快照。
2. Core 检查同一输入是否已有成功或运行中的任务，避免重复生成。
3. 创建 Knowledge Run，并写入独立 Redis Stream：knowledge:tasks；消费者按 runId 拉取完整命令。
4. Knowledge Generator 完成后，Core 创建 Wiki 版本和候选 Skill 版本。
5. 候选 Skill 发布后，Core 自动创建 Skill Lab Run，并写入 skilllab:tasks。
6. Skill Lab 返回结果：通过则发布优化版本；未提升则标记 rejected，继续保留旧版本。

### 5.2 手动生成

用户点击工程知识资产面板中的重新生成后，Core 仍绑定当前 GraphVersion。相同版本的普通请求保持幂等；显式强制生成需生成新的 runId，但不能直接覆盖旧版本。

### 5.3 过期判断

Project 切换到新 GraphVersion 时，如果资产的 sourceGraphVersionId 不同，Core 立即将其标记为 stale，并启动新一轮生成。界面继续允许查看旧版本，但必须显示来源版本和过期状态。

### 5.4 进度通知

Core 统一发出以下 SSE 事件：

- knowledge.run.updated
- knowledge.asset.published
- skilllab.run.updated
- skill.version.published

SSE 只通知客户端刷新；最终状态始终通过 REST 从 PostgreSQL 重新读取。

## 6. 代码改动范围

### 阶段一：契约与 Schema

- 新增 Core 与两个模块共享的命令、回调和 Artifact Manifest Schema。
- 后端和前端 DTO 同步增加 KnowledgeAsset、AssetVersion、KnowledgeRun、SkillLabRun。
- 为所有消息增加 schemaVersion、idempotencyKey 和 checksum。

### 阶段二：存储与基础设施

- 新增数据库迁移及 Repository 层。
- 在 Redis 访问层增加 knowledge:tasks 和 skilllab:tasks，使用独立 Consumer Group。
- 在 Artifact 层增加短期上传/下载授权，不向扩展模块暴露 OSS 长期密钥。

### 阶段三：Core 编排

- 新增 knowledgeOrchestrator 与 skillLabOrchestrator Service。
- 新增公开 Knowledge API 和内部回调 API。
- 在 GraphVersion 发布成功后触发 Knowledge Orchestrator。
- 加入幂等、重试、超时、状态迁移校验和审计日志。

### 阶段四：Electron 接入

- 将现有“工程知识资产”面板从静态数据改为 Core API 数据。
- 展示 Wiki/Skill 的状态、版本、来源 commit、目录、预览和下载。
- 接收 SSE 后局部刷新资产与任务状态。
- 失败时保留旧资产，并提供错误详情和重试入口。

### 阶段五：模块联调

- 先用 Mock Knowledge Generator 和 Mock Skill Lab 验证 Core 闭环。
- 契约测试通过后，再替换为真实模块。
- 两个模块分别使用独立进程、镜像和消费组，可单独发布与回滚。

## 7. 并行开发拆分

- Agent A：Core 数据库、任务编排、API、回调、SSE 与前端绑定。
- Agent B：Knowledge Generator，严格按 Contract v1 消费和回调。
- Agent C：Skill Lab，严格按 Contract v1 消费和回调。

三方只共享契约和测试样例，不直接引用彼此源码，也不直接访问彼此数据库。

## 8. 安全与可靠性硬门槛

- 所有公开接口执行 Project 成员鉴权；内部回调使用独立服务身份。
- 任务与回调必须校验 projectId、runId、状态迁移和幂等键。
- OSS 使用短期授权；日志、Redis 消息和数据库不得保存明文密钥。
- Artifact 必须校验大小、类型、checksum 和 Manifest Schema。
- 扩展模块失败不得影响图谱、Chat、现有文档或上一版知识资产。
- Core 是唯一版本发布者；扩展模块无权直接设置 active version。

## 9. 部署顺序

1. 先以 `KNOWLEDGE_INTEGRATION_ENABLED=false` 部署新版 Core 和 Electron，验证所有原有功能不受影响。
2. 合并 Contract v1，执行数据库迁移，并保持扩展开关关闭。
3. 为两个消费者配置相同的 `INTEGRATION_SERVICE_TOKEN`，部署 Knowledge Generator 和 Skill Lab Consumer。
4. 设置 `KNOWLEDGE_INTEGRATION_ENABLED=true`，但保持 `KNOWLEDGE_AUTO_GENERATE=false`。
5. 使用测试 Project 手动跑通 Wiki → 候选 Skill → 评测 → 发布闭环。
6. 验证 Electron 的 REST 降级和 SSE 刷新后，再开启新 GraphVersion 自动触发。

## 10. 验收标准

- 同一 GraphVersion 重复触发不会生成重复有效版本。
- Wiki 和 Skill 均可查看状态、版本、来源 commit、目录、预览和下载。
- Knowledge Generator 成功后会自动触发一次 Skill Lab 任务。
- Skill Lab 未提升时不会替换当前 Skill；提升后可看到分数、报告和 Diff。
- 任一模块超时或失败时，旧版本仍可正常使用，界面能显示错误并重试。
- Electron 收到 SSE 后能刷新状态，断线重连后可通过 REST 恢复正确状态。
- 两个扩展模块可以独立停机、升级和回滚，不影响 VisionOwl Core 主链路。
