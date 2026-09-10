# VisionOwl

[English](#english) · [中文](#中文) · [Deployment Guide](./DEPLOYMENT.md)

## English

VisionOwl is a self-evolving engineering knowledge base for software teams. It connects GitHub repositories, code graphs, engineering documents, and AI agents in a continuous loop: the initial scan establishes a knowledge baseline, while later pushes trigger incremental analysis and stream updated graphs and documents to the desktop app.

### Highlights

- Bind a public GitHub repository and branch for full or incremental analysis.
- Dispatch jobs through Redis Streams and run deterministic scanning plus Qoder enrichment in isolated runners.
- Version code graphs, source evidence, architecture documents, and knowledge artifacts in local storage or OSS.
- Stream job progress and graph changes to the Electron client over SSE.
- Ground agent chat and document generation in source code, graphs, commit history, and documents.
- Generate evidence-linked Wiki and Skills with Knowledge Generator, then evaluate candidates in Skill Lab.

### Architecture

```text
GitHub Push ──> Cloud API ──> Redis Streams ──> Worker ──> Runner / Qoder
     │              │                              │
     │              ├──> PostgreSQL                ├──> Graph + Evidence
     │              ├──> OSS / Artifact Storage    └──> Documents
     │              └──> SSE
     └──────────────────────────────> Electron Desktop

Knowledge Generator <── Redis / Core API ──> Skill Lab
```

### Repository

| Path | Responsibility |
|---|---|
| `app/` | Electron + React desktop client for projects, graphs, and agent interaction |
| `cloud-backend/` | Fastify API, GitHub webhook, Redis worker, scanner, and runner orchestration |
| `knowledge-generator/` | Evidence-grounded Wiki, documentation, and Skill generation |
| `skill-lab/` | Isolated Skill evaluation, optimization, and quality gates |
| `skills/` | Repository understanding, graph, and documentation policies used by runners |
| `docs/` | Architecture, collaboration, acceptance, and evolution notes |

### Desktop Quick Start

Install Node.js 22, npm, and Git. Configure `app/.env.production`:

```dotenv
VITE_USE_MOCK=false
VITE_API_BASE=https://<your-domain>
```

```bash
cd app
npm ci
npm run dev:cloud
```

Use `npm run dev:mock` for a UI-only demo. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full local stack and ECS deployment.

> Never commit environment files, private keys, tokens, DWS credentials, or generated source workspaces.

## 中文

VisionOwl 是面向团队的自进化工程知识库。它将 GitHub 仓库、代码图谱、工程文档和 AI Agent 连接为持续更新的闭环：首次分析建立知识基线，后续 Push 通过 Webhook 触发增量分析，并将新图谱与文档实时同步到桌面端。

### 核心能力

- 绑定公开 GitHub 仓库与指定分支，执行全量或增量代码分析。
- 通过 Redis Streams 调度 Worker，在隔离 Runner 中完成确定性扫描与 Qoder 语义增强。
- 版本化保存代码图谱、源码证据、架构文档和知识产物，并支持本地存储或 OSS。
- 通过 SSE 向 Electron 客户端推送任务进度和图谱更新。
- 基于源码、图谱、提交历史和文档提供可溯源的 Agent 问答与文档生成。
- 由 Knowledge Generator 沉淀 Wiki 与 Skills，由 Skill Lab 评估和优化候选 Skills。

### 架构

```text
GitHub Push ──> Cloud API ──> Redis Streams ──> Worker ──> Runner / Qoder
     │              │                              │
     │              ├──> PostgreSQL                ├──> 图谱与源码证据
     │              ├──> OSS / Artifact Storage    └──> 工程文档
     │              └──> SSE
     └──────────────────────────────> Electron 桌面端

Knowledge Generator <── Redis / Core API ──> Skill Lab
```

### 目录

| 路径 | 职责 |
|---|---|
| `app/` | Electron + React 桌面端，负责项目管理、图谱展示和 Agent 交互 |
| `cloud-backend/` | Fastify API、GitHub Webhook、Redis Worker、扫描器和 Runner 调度 |
| `knowledge-generator/` | 基于代码与工程证据生成可追溯 Wiki、文档和 Skills |
| `skill-lab/` | 对候选 Skills 进行隔离评测、优化和质量门禁 |
| `skills/` | Runner 使用的代码理解、图谱和文档生成规则 |
| `docs/` | 架构、协作、验收与演进设计文档 |

### 快速启动桌面端

安装 Node.js 22、npm 和 Git，并编辑 `app/.env.production`：

```dotenv
VITE_USE_MOCK=false
VITE_API_BASE=https://<your-domain>
```

```bash
cd app
npm ci
npm run dev:cloud
```

仅体验界面可执行 `npm run dev:mock`。完整本地联调和 ECS 部署见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

> 不要提交环境文件、私钥、Token、DWS 登录态或生成的源码工作区。
