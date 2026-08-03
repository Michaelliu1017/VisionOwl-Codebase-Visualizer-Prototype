# VisionOwl 产品与系统 Spec

## 0. 文档信息

| 项目 | 内容 |
|---|---|
| 产品名称 | VisionOwl |
| 产品定位 | AI 辅助、证据可追溯、可持续更新的代码知识图谱与团队知识空间 |
| 文档类型 | 产品需求、系统设计与验收规范的统一 Spec |
| 当前产品阶段 | Stage 2：本地单机版本已完成核心闭环；联网协作尚未实现 |
| 目标形态 | 本地受限分析器 + 云端协作服务 + Web/Electron 客户端 |
| 本地仓库访问 | 用户运行时选择本地 Git 仓库；Project 绑定创建时的 Real Path 与分支 |
| 文档状态 | Draft，作为后续实现、评审和验收的单一事实源 |

### 0.1 状态标记

本文使用以下状态：

| 状态 | 含义 |
|---|---|
| 已实现 | 当前 VisionOwl 代码中已经存在，可在本地运行和验证 |
| 部分实现 | 已有基础能力，但尚未达到本文定义的完整要求 |
| 规划 | 属于目标产品能力，当前尚未实现 |
| 非目标 | 当前阶段明确不做，避免无边界扩张 |

### 0.2 规范用语

- 必须：缺失时不能通过验收。
- 应该：原则上需要实现，除非有明确且记录在案的替代方案。
- 可以：可选能力，不影响当前阶段验收。
- 代码事实：可由源码文件、符号、依赖或配置证据直接证明的信息。
- AI 推断：AI 根据代码事实得出的解释，必须与代码事实分开呈现。

---

## 1. 产品定义

### 1.1 一句话描述

VisionOwl 将代码仓库分析成可交互、可追溯、可持续更新的架构知识图谱，并把 AI 问答、模块文档、团队批注和版本协作统一到同一个工作空间中。

### 1.2 产品要解决的问题

复杂代码库通常存在以下痛点：

1. 新成员很难快速识别系统边界、核心模块、关键执行链路和基础设施依赖。
2. 普通目录树只能展示文件层级，无法解释模块职责和跨模块调用关系。
3. 传统架构图依赖人工维护，代码变化后很快失真。
4. AI 生成的架构解释如果没有文件、符号和行号证据，难以信任和复核。
5. 代码、钉钉文档、模块批注和团队分工散落在不同工具中，知识无法围绕模块聚合。
6. 使用者选中模块后，无法直接带着该模块的上下文和 AI 继续讨论。
7. 本地分析结果难以安全地分享给团队；直接把本地服务暴露到公网又会带来源码和文件系统泄露风险。
8. 代码提交后，相关模块文档和全局架构文档容易过期，人工逐篇维护成本高。

### 1.3 产品价值

- 对开发者：用图谱快速理解代码结构、依赖方向和执行流程。
- 对维护者：把代码事实、架构解释、文档和批注集中到模块上下文中。
- 对团队：共享同一个已发布图谱版本，减少口头传递和重复理解成本。
- 对负责人：通过版本、权限和审计保证共享知识可追踪、可回滚。
- 对安全场景：源码留在本地，云端只接收经过校验的脱敏图谱。

### 1.4 核心产品原则

1. 代码事实优先：模块和关系必须尽量来源于可验证的源码证据。
2. AI 负责增强，不负责捏造：AI 可以命名、总结和解释，但不能创造不存在的依赖。
3. 图谱不是图片：节点必须可选择、可查询、可关联文档和批注。
4. 执行流不是生产 Trace：路径推演只表达源码支持的可能交互，不冒充线上实时行为。
5. 知识围绕稳定模块身份组织：文档和批注不能绑定一次分析产生的临时节点。
6. 联网协作默认不上传完整私有源码。
7. 云端不能获得对主机文件系统的通用控制能力。

---

## 2. 产品目标与边界

### 2.1 产品目标

#### G1：生成可信的代码架构图

系统必须从真实仓库中识别代码域、模块、关键符号、外部资源和关系，并保存可追溯证据。

#### G2：支持从全局到局部的交互式理解

用户必须能够查看系统全景、聚焦单个模块、检查上下游和推演关键执行路径。

#### G3：让 AI 获得正确的模块上下文

用户选中模块后，AI Chat 必须自动带入模块事实、邻接关系、源码证据、文档和批注。

#### G4：建立可自动维护的代码文档库

模块可以挂载外部文档，全局可以挂载架构文档；Git Commit 发生变化后，系统能够识别受影响文档并更新。

#### G5：实现安全的团队共享

Owner 可以创建 Project、邀请成员和发布图谱；成员根据角色访问同一份云端图谱、文档和批注。

#### G6：保持版本一致性和可追溯性

每次发布生成独立 Graph Version，不能静默覆盖；用户能够查看版本来源、激活状态和历史记录。

### 2.2 非目标

当前 Spec 不要求实现以下能力：

- 线上系统实时指标监控、故障告警或生产 Trace 可视化。
- 根据模拟数据宣称真实延迟、QPS、错误率或健康状态。
- 云端直接保存所有私有源代码。
- 云端向主机下发任意 Shell 命令或任意本地路径。
- 在线 IDE、代码编辑器或代码托管平台替代品。
- 多人实时共同拖拽同一图谱布局。
- 多人共同编辑钉钉文档正文。
- 第一阶段支持复杂企业组织树、部门继承和跨 Project 权限。
- 第一阶段自动修改代码。

### 2.3 当前版本与目标版本边界

| 能力 | 当前本地版 | 联网目标态 |
|---|---|---|
| 本地仓库导入 | 已实现 | 仍由 Owner 本地执行 |
| 确定性代码扫描 | 已实现 | 保留在本地受限分析器 |
| Codex 语义增强 | 已实现 | 保留本地优先，可扩展云端受控执行 |
| 交互式架构图 | 已实现 | 浏览器协作者可查看云端版本 |
| 模块 AI Chat | 已实现 | 云端基于脱敏上下文，深度源码问题可委托 Owner 本地 Agent |
| 文档与批注 | 基础能力已实现 | 云端统一存储关系和协作数据 |
| Debug Commit 监听 | 已实现 | 作为本地草稿或发布来源 |
| 多用户和权限 | 未实现 | 规划 |
| 邀请密钥 | 未实现 | 规划 |
| 图谱发布与回滚 | 本地仅保留版本 | 云端完整实现 |
| 实时协作同步 | 未实现 | 规划 |
| GitHub/GitLab/Aone Webhook | 未实现 | 后续阶段规划 |
| 本地仓库运行时校验与脱敏上传 | 已实现 | 当前能力 |

---

## 3. 用户、角色与使用场景

### 3.1 用户类型

#### Owner

Project 的所有者和图谱事实发布者，通常是仓库负责人或本地代码持有者。

主要诉求：

- 选择并分析仓库。
- 校验图谱是否准确。
- 发布、激活和回滚图谱版本。
- 邀请成员并管理权限。
- 决定哪些本地 Commit 可以共享。
- 查看文档自动更新结果和审计记录。

#### Editor

共同维护代码知识的团队成员。

主要诉求：

- 查看并理解图谱。
- 添加批注。
- 挂载或更新文档。
- 使用 AI Chat。
- 对低置信度模块迁移提出修正。

#### Viewer

只需要消费知识的成员，如新同学、测试、产品或跨团队协作者。

主要诉求：

- 查看当前已发布图谱。
- 查看模块详情、文档和批注。
- 根据配置使用只读 AI Chat。

#### Local Agent Host

运行 Electron 和本地分析器的受信主机。它不是业务角色，但在系统架构中承担读取私有源码的职责。

### 3.2 权限矩阵

| 操作 | Owner | Editor | Viewer |
|---|---:|---:|---:|
| 查看图谱和模块详情 | 允许 | 允许 | 允许 |
| 查看模块文档和全局文档 | 允许 | 允许 | 允许 |
| 使用 AI Chat | 允许 | 允许 | 项目可配置 |
| 创建批注 | 允许 | 允许 | 不允许 |
| 修改自己的批注 | 允许 | 允许 | 不允许 |
| 删除他人的批注 | 允许 | 不允许 | 不允许 |
| 挂载和解除文档 | 允许 | 允许 | 不允许 |
| 手动触发文档更新 | 允许 | 允许 | 不允许 |
| 上传图谱版本 | 允许 | 默认不允许 | 不允许 |
| 激活或回滚图谱 | 允许 | 不允许 | 不允许 |
| 创建邀请和管理成员 | 允许 | 不允许 | 不允许 |
| 修改 Project 设置 | 允许 | 不允许 | 不允许 |
| 删除 Project | 允许 | 不允许 | 不允许 |

后续可以给特定 Editor 增加 `publish_graph` 权限，不新增固定角色。

### 3.3 核心使用场景

#### S1：首次理解代码库

用户导入本地仓库，观察分析进度，进入系统全景图，识别代码域、模块、基础设施和关键执行流。

#### S2：排查模块关系

用户选中一个模块，查看其职责、成员、上游、下游、内部关系和源码证据。

#### S3：沿执行流理解业务

用户选择动态生成的执行流，例如任务创建、任务拉取或结果写入，按真实方向查看跨模块调用步骤。

#### S4：针对模块询问 AI

用户选中模块，在 Chat 中询问“它负责什么”“谁调用它”“这条链路如何执行”；AI 使用选中上下文并给出证据。

#### S5：挂载或生成模块文档

用户给代码域或模块挂载钉钉文档，也可以让 Agent 生成代码文档并自动绑定。

#### S6：维护全局架构文档

用户在 Project 级别挂载不属于单一模块的总体架构文档，文档始终在全局入口可见。

#### S7：代码提交后自动维护文档

Owner 开启 Debug 模式，新 Commit 被识别；系统标记图谱过期，分析 Diff，更新受影响模块文档和必要的全局文档。

#### S8：团队共享图谱

Owner 创建云端 Project 和邀请，协作者兑换邀请后查看同一 Active Graph Version。

#### S9：图谱发布与同步

Owner 发布新版本，云端校验后激活；在线协作者收到更新，离线协作者重连后恢复最新状态。

#### S10：远端 master 自动更新

后续由 GitHub、GitLab 或 Aone 的 Webhook/CI 检测远端 master 变化，触发受控分析和版本发布。

---

## 4. 核心概念与术语

| 术语 | 定义 |
|---|---|
| Project | VisionOwl 中组织仓库、图谱版本、成员、文档和批注的协作边界 |
| Repository | 被分析的 Git 代码仓库 |
| Graph Version | 某个仓库分支和 Commit 对应的一份不可变图谱产物 |
| Active Graph | 当前对 Project 成员可见的正式图谱版本 |
| Draft Graph | 尚未激活的本地或云端草稿版本 |
| Graph Entity | 图谱节点，可表示代码域、模块、运行时资源、数据存储或外部服务 |
| Graph Relation | 图谱有向或无向关系，如 imports、calls、reads、writes、publishes |
| Code Domain | 一组职责接近的模块容器，不应只等同于文件夹名称 |
| Module | 具有明确职责和代码证据的分析单元 |
| Execution Flow | 由源码证据支持的一条可能执行链路，不等于线上 Trace |
| Source Evidence | 支撑节点或关系的相对文件、行号、符号和有限摘录 |
| Stable Entity ID | 跨图谱版本维持模块身份的稳定标识 |
| Document Binding | 文档与 Project 或 Stable Entity 的挂载关系 |
| Annotation | 团队成员针对模块留下的结构化批注 |
| Local Agent | 在 Owner 主机上读取授权源码并生成图谱的本地进程 |
| Agent Harness | 控制 Agent 输入、工具、权限、循环、输出 Schema 和安全边界的编排层 |
| Sanitized Graph | 去除绝对路径、完整源码和凭证后的可上传图谱产物 |
| Repository Fingerprint | 不暴露完整源码的仓库稳定标识 |
| DWS | 当前本地创建和更新钉钉文档使用的已认证 CLI |

---

## 5. 产品信息架构

### 5.1 主要页面

#### 本地桌面首页

- Project 列表。
- 导入仓库入口。
- 最近分析状态。
- 当前分支、Commit 和图谱新鲜度。
- 本地 Project 与云端 Project 的绑定状态。

#### 图谱工作区

- 顶部产品栏、视图切换、Project 选择和仓库操作。
- 图谱概览指标：模块数、关系数、证据数、版本。
- 动态执行流导航。
- 全局文档入口。
- 中央交互式图谱。
- 右侧模块详情或 AI Chat。
- 分析进度和文档更新状态。

#### 云端 Project 管理页

- Project 基础信息。
- 当前 Active Graph Version。
- 成员和角色。
- 邀请密钥管理。
- 图谱版本列表、激活和回滚。
- 文档同步任务和审计记录。

#### 登录与加入页

- 用户登录。
- 输入邀请密钥加入 Project。
- 展示邀请角色、有效期和目标 Project。

### 5.2 图谱工作区视图

#### 系统全景

展示全部可见代码域、模块、外部资源和高价值关系，目标是理解整体结构。

#### 模块聚焦

以选中模块或代码域为中心，强调直接上游、直接下游、内部成员、文档和批注。

#### 路径推演

根据选中模块和源码关系计算可能交互路径，以方向动画表达 A 到 B 的调用方向。双向关系不得伪装为单向脉冲。

#### 执行流视图

分析器识别到 Execution Flow 后，顶部动态生成执行流按钮。按钮名称必须来自当前图谱，不能写死为某个特定项目的业务流程。

### 5.3 图形语义

- 代码域：绿色细边框、透明内部，作为模块分组容器。
- 代码模块：深色磨砂玻璃卡片，显示模块名和职责副标题。
- 数据存储和外部资源：外观与代码模块明确区分，并标注 Redis、MySQL、SLS 等资源类型。
- 选中模块：绿色半透明填充和外发光。
- 关联文档与批注：灰色半透明磨砂玻璃卡片，通过虚线连接到挂载对象。
- 普通关系：低亮度中性色，带清晰方向和常驻标签。
- 选中关系：高亮绿色；不相关节点降低对比度但不能完全消失。
- 关系线不能穿过无关卡片，不能盖住关系标签或模块标题。

---

## 6. 功能需求

## 6.1 Project 与仓库管理

### FR-PROJ-001：导入本地仓库

状态：已实现，联网前需要安全改造。

- 用户可以输入 Project 名称并通过 Electron 目录选择器选择仓库。
- 当前实现接受可读目录；联网安全版本必须只允许显式授权仓库。
- 系统应该识别 Git 分支和当前 Commit。
- Project 列表需要展示名称、更新时间、节点数和关系数。

### FR-PROJ-002：Project 切换

状态：已实现。

- 用户可以在多个本地 Project 之间切换。
- 切换后必须加载对应图谱、文档、自动化状态和分析任务。
- Project 之间的选中状态、Chat 上下文和文档关系不得串用。

### FR-PROJ-003：云端 Project 创建

状态：规划。

- 已登录用户可以创建云端 Project。
- 创建者自动成为 Owner。
- Project 必须包含稳定 Project ID、名称、Owner、默认分支、仓库指纹和当前图谱版本引用。
- 本地 Project 与云端 Project 的绑定必须经过 Owner 明确确认。

### FR-PROJ-004：本地仓库绑定与校验

状态：已实现。

- 用户通过 Electron 在运行时选择本地 Git 仓库，不需要启动时预配置仓库名单。
- Local Agent 只接受经过本地 Token、Host 和 Origin 校验的请求，并拒绝文件系统根目录、用户主目录、符号链接逃逸和父目录穿越。
- Project 创建后保存仓库 Real Path 与当前命名分支。
- 每次分析、Chat、文档生成和文档更新都必须重新校验路径、Git 仓库状态和 Project 分支。

## 6.2 代码分析

### FR-ANL-001：分析流水线

状态：已实现。

分析至少包括：

1. 前置检查和仓库盘点。
2. 文件与语言扫描。
3. import、符号和目录结构提取。
4. 模块聚类与基础事实图生成。
5. 基础设施和外部依赖识别。
6. 跨模块关系与执行流提取。
7. Codex 语义增强。
8. 架构质量校验。
9. 图谱保存和发布。

当前阶段名称可以映射为 `ua_preflight`、`ua_scan`、`facts_ready`、`ua_analyze`、`enriching`、`ua_review`、`ua_architecture`、`architecture_ready`、`ua_tour`、`ua_validate`、`ua_save`、`completed` 或 `failed`。

### FR-ANL-002：确定性分析优先

状态：已实现。

- 系统必须先运行 Understand Anything 的确定性脚本，生成 import、symbols、clusters 和基础图谱。
- Codex 只对有限批次做命名、摘要、架构边界和执行流增强。
- Codex 不可用时，基础图谱仍然必须生成。

### FR-ANL-003：中间状态可见

状态：已实现。

- 分析开始后，界面必须展示阶段、进度、当前动作和最近消息。
- 后端通过 SSE 推送分析事件。
- 用户能够区分“仍在分析”“分析失败”和“应用卡死”。
- 分析完成前可以先发布事实基础图，再继续语义增强。

### FR-ANL-004：证据约束

状态：已实现核心约束。

- 每个重要模块和关系应该至少关联一条 Source Evidence。
- 证据使用仓库相对路径、行号和符号。
- AI 只能解释已存在事实，新增关系必须有代码证据。
- 无证据的架构推断必须标记为推断，不得作为确定关系进入图谱。

### FR-ANL-005：基础设施识别

状态：部分实现。

- 分析器应该识别 Redis、MySQL、PostgreSQL、SLS、OSS、消息队列、HTTP/RPC 服务等非代码实体。
- 识别来源包括依赖库、配置键、客户端构造、DAO、队列操作和网络调用。
- 基础设施实体必须与相关代码模块通过 `reads`、`writes`、`publishes`、`consumes` 或 `connects` 等关系连接。
- 不得因为基础设施不对应源码目录而省略。

### FR-ANL-006：执行流生成

状态：部分实现。

- 系统应识别关键入口、跨模块调用、队列读写、数据存储和最终输出。
- 每条 Execution Flow 包含名称、摘要、入口、节点顺序、关系顺序和泳道。
- 执行流名称根据当前项目代码生成，不能由前端写死。
- 执行流只表达代码层可行路径，必须在界面中避免称为实时运行链路。

### FR-ANL-007：缓存与增量分析

状态：部分实现。

- 相同仓库、Commit、分析器版本和 Skill 版本可以复用确定性中间产物。
- Commit 变化时，系统应优先重算受影响模块和跨模块关系。
- 语义增强应该按批次并发，但必须限制并发数。
- 缓存不能跨仓库指纹误用。

## 6.3 图谱数据模型

### FR-GRAPH-001：实体类型

状态：已实现基础模型。

Graph Entity 至少包含：

- `id`、`projectId`、`category`、`kind`、`name`、`summary`。
- `path`、`language`、`layer`、`tags`、`metadata`。
- `evidence`。
- 可选布局位置。

实体类别包括：

- `code`：代码域、模块、组件、函数或关键符号。
- `data`：数据库、缓存、日志库、对象存储和消息系统。
- `external`：第三方服务、远端 API 和外部平台。
- `runtime`：仅用于明确启用且有真实数据来源的运行时实体；默认静态代码产品不使用虚构运行状态。

### FR-GRAPH-002：关系类型

状态：已实现基础模型。

关系至少包含：

- `source` 和 `target`。
- `type` 和用户可读 `label`。
- `directed`。
- `generated`。
- `metadata` 和 `evidence`。

常见关系包括 `contains`、`imports`、`calls`、`reads`、`writes`、`publishes`、`consumes`、`renders`、`uses`、`returns`。

### FR-GRAPH-003：代码域

状态：部分实现。

- 代码域必须基于职责、关系密度、仓库边界和架构层次生成。
- 仓库根文件夹不得自动成为一个没有业务含义的 Root 节点。
- 代码域标题必须是项目事实或语义总结，不应直接使用不具备含义的目录名。
- 代码域应支持展开、折叠和整体选中分析。

### FR-GRAPH-004：稳定模块身份

状态：规划。

- 每个可挂载知识的模块必须有 Stable Entity ID。
- 稳定 ID 至少综合仓库指纹、规范路径、模块类型和入口符号。
- 文件内容变化但路径不变时保持 ID。
- Git Rename 或移动时结合重命名证据和语义指纹迁移。
- 拆分、合并和低置信度迁移进入人工确认状态。

### FR-GRAPH-005：人工修正层

状态：规划。

- Owner 和 Editor 可以修正模块显示名称、职责摘要、代码域归属和业务标签。
- 人工修正必须作为独立 Overlay 保存，不能覆盖或伪造 Scanner 产生的源码事实。
- 删除有源码证据的关系时，系统应记录为“用户隐藏”或“用户否决”，保留原始关系以供审计。
- 图谱重新分析后，应按 Stable Entity ID 继续应用有效修正。
- 如果新代码事实与人工修正冲突，系统必须提示复核，不能静默沿用。

## 6.4 图谱展示与交互

### FR-UI-001：自适应布局

状态：已实现并持续优化。

- 使用 ELK 分层布局减少交叉。
- 横向屏幕优先采用适合宽画布的金字塔或分层排列。
- 模块间距必须根据标签宽度、关系密度和容器大小自适应。
- 关系不得与模块边框重叠或从模块正文穿过。
- 布局必须优先保证方向和可读性，而不是追求最紧凑面积。

### FR-UI-002：关系可读性

状态：已实现核心能力。

- 关系标签默认可见，不要求先点击节点。
- 标签必须说明动作和方向，例如 `Fetcher.Run pulls tasks from AgentClient`。
- A imports B 的动画方向必须从 A 指向 B。
- 双向依赖不使用误导性的单向脉冲。
- 多条同类关系可以聚合，但用户必须能够展开查看证据。

### FR-UI-003：节点选择

状态：已实现。

- 单击模块或代码域即可选中。
- 再次单击当前对象应取消选择。
- 单击另一个对象不应要求双击。
- 选中后突出直接关系，保留相关模块正常显示，降低无关模块对比度。
- 选中关系线不得被节点遮挡，也不得盖住其他相关节点。

### FR-UI-004：模块详情

状态：已实现。

详情面板至少显示：

- 模块名称、类别、路径、语言和职责。
- 上游、下游和内部关系。
- 成员模块或关键符号。
- 源码证据。
- 关联文档。
- 团队批注。

### FR-UI-005：搜索和定位

状态：已实现基础能力。

- 用户可以按模块名或路径搜索。
- 搜索命中节点需要在画布中突出显示。
- 只有目标或相关弹出内容在视口外时才自动调整视图，不能每次选择都强制居中。

### FR-UI-006：文档展示

状态：已实现。

- 全局文档在画布固定入口展示，不依赖模块选择。
- 模块文档默认在选中模块时浮现。
- 用户可以切换“一次显示全部文档”。
- 文档卡片使用与代码模块不同的灰色磨砂玻璃风格。
- 任意数量文档都必须保持连接线，不得在第五个文档后丢失。
- 挂在代码域上的文档也必须连接到代码域。

### FR-UI-007：模块卡片信息

状态：已实现核心能力。

- 卡片主标题显示模块名称或关键符号名称。
- 卡片副标题必须简洁描述模块用途，不能重复文件夹名、类型名或内部 ID。
- 描述过长时可以截断，但完整内容必须可通过 Tooltip 或详情面板读取。
- 关系标签和模块副标题必须采用独立布局，不能彼此遮挡。

## 6.5 AI Chat

### FR-AI-001：上下文构建

状态：已实现。

用户选中模块或代码域后，Chat 请求必须包含：

- 当前 Project 和 Graph Version。
- 选中实体或 Entity Scope。
- 直接上游、下游和内部关系。
- 模块成员。
- Source Evidence。
- 关联文档和批注。
- 当前会话历史。

### FR-AI-002：结构化回答

状态：已实现。

回答至少分为：

- 结论。
- 模块用途。
- 调用链。
- 代码事实。
- AI 推断。
- 注意事项。
- 源码引用。

不得把“没有 Git 元数据”等低价值内部提示放在回答正文的显著位置，除非它直接影响结论可信度。

### FR-AI-003：中间态

状态：已实现。

- Chat 必须展示上下文建立、证据收集、分析和格式化进度。
- 长时间分析不能保持静默。
- 失败时显示可理解错误和重试入口。

### FR-AI-004：快捷动作

状态：已实现核心动作。

选中模块后 Chat 提供：

- 生成代码文档。
- 更新已挂载文档。
- 询问该模块职责。
- 询问上下游和调用链。

后续可以增加“解释最近变更”和“比较两个图谱版本”。

### FR-AI-005：联网 Chat 隐私边界

状态：规划。

- 云端没有源码时，只能使用脱敏图谱、摘要、有限证据、文档和批注回答。
- 需要完整源码的问题默认委托 Owner 本地 Agent。
- 云端不能利用 Chat 参数访问主机任意文件。
- 所有云端 AI 请求记录 Project、用户、Graph Version 和权限审计。

## 6.6 文档与批注

### FR-DOC-001：挂载模块文档

状态：已实现。

- 用户可以给模块或代码域添加外部文档链接。
- 文档字段包括标题、URL、摘要、Provider、外部 ID、同步状态和更新时间。
- 钉钉链接自动标记为 `dingtalk` Provider。

### FR-DOC-002：挂载全局文档

状态：已实现。

- 全局文档绑定 Project，而不是某个模块。
- 全局文档用于总体架构、开发规范、部署手册和跨模块设计。
- 当前本地实现可使用 Project Document Owner 虚拟标识；联网数据模型应使用明确的 Project Global Scope。

### FR-DOC-003：生成代码文档

状态：已实现。

- 用户选中模块或代码域后可以触发生成。
- Module Documentation Skill 必须读取模块事实、关系和证据。
- Agent 生成结构化正文后，通过本地 DWS 创建钉钉文档。
- 创建成功后自动保存 Document Binding。
- UI 展示上下文、分析、发布和绑定四阶段进度。

### FR-DOC-004：更新已挂载文档

状态：已实现。

- 用户可以手动要求 Agent 检查并更新选中模块的钉钉文档。
- Agent 必须先读取原文档，再根据当前源码证据增量修改。
- 没有变化的文档不得为了“看起来更新过”而改写。
- 结果显示检查、更新和无需修改的文档数量。

### FR-DOC-005：Commit 自动维护

状态：已实现本地 Debug 版；联网版规划。

- Debug 模式记录 observed Commit 和 processed Commit。
- 新 Commit 出现后，系统计算 Diff 和受影响模块。
- 受影响模块文档进入更新任务。
- 架构结构、跨模块流程或基础设施发生变化时，全局文档进入检查任务。
- UI 必须显著提示代码已变化，并让“重新分析”按钮持续呼吸闪烁。
- 文档更新时弹出进度窗口，显示正在更新的文档、阶段、进度和结果。
- 未提交工作区变化不触发正式文档更新。

### FR-DOC-006：文档同步可审核

状态：规划。

- 正式联网模式应先生成可审核更新，再决定自动发布或人工确认。
- 每次更新记录来源 Commit、受影响模块、更新摘要、执行 Agent 和结果。
- 文档失败不能阻塞图谱版本激活，但必须可重试。

### FR-DOC-007：Project 文档库

状态：规划。

- Project 提供统一文档库，集中展示全局文档和所有模块文档。
- 用户可以按标题、Provider、模块、同步状态和最近更新时间检索或筛选。
- 文档库中的每篇模块文档必须能跳回对应图谱实体。
- Archived 模块的文档仍可访问，并明确显示历史状态。
- 文档库只保存正文外的索引和关系；外部文档正文是否缓存由 Provider 和权限策略决定。

### FR-ANN-001：模块批注

状态：部分实现。

- 用户可以给模块添加作者和正文。
- 联网后批注必须保存创建者、更新时间、版本号和软删除状态。
- Editor 修改批注使用乐观锁；冲突时提示合并。
- Viewer 不能创建或修改批注。

### FR-ANN-002：模块负责人和团队分工

状态：规划。

- Owner 和 Editor 可以为 Stable Entity 标注负责人、协作成员或团队。
- 一个模块可以有一个主要负责人和多个协作成员。
- 负责人信息在模块详情和 Project 模块目录中可见，默认不占用主图大量空间。
- 模块跨版本迁移后继续保留负责人关系。
- 成员被移出 Project 后，其历史责任记录保留，但当前负责人状态进入待重新分配。

## 6.7 Git 变更与自动化

### FR-GIT-001：本地 Debug 模式

状态：已实现。

- 仅监听当前 Project 已绑定仓库和分支。
- 新 Commit 可在尚未 Push 时被识别。
- 系统显示 `watching`、`running`、`idle` 或 `error`。
- 本地 Commit 默认只能更新本地主机状态。

### FR-GIT-002：Shared Draft

状态：规划。

- Owner 可以明确将未 Push Commit 生成的图谱发布为 Shared Draft。
- Shared Draft 必须显示“未推送草稿”标识。
- 普通协作者默认只看 Published Active Graph。

### FR-GIT-003：远端 master 监听

状态：规划。

- 正式自动更新以远端 master 为事实源。
- GitHub、GitLab 或 Aone 通过 Webhook/CI 触发分析。
- 服务端必须验证事件签名、仓库、分支和 Commit。
- 同一 Commit 的重复事件必须幂等。
- Owner 电脑离线时，远端分析仍应能够完成。

## 6.8 联网协作

### FR-COLLAB-001：用户身份

状态：规划。

- 用户需要登录后才能加入或访问私有 Project。
- 使用短期 Access Token 和可撤销 Refresh Token。
- Project 成员身份是权限判断依据，邀请密钥不是永久登录凭证。

### FR-COLLAB-002：邀请密钥

状态：规划。

- Owner 可以创建 Editor 或 Viewer 邀请。
- 邀请支持有效期、最大次数和立即撤销。
- 密钥至少使用 128 位随机值。
- 服务端只保存密钥哈希，完整值只展示一次。
- 用户兑换成功后生成 Project Member 记录。

### FR-COLLAB-003：成员管理

状态：规划。

- Owner 可以查看成员、角色和加入时间。
- Owner 可以修改角色、移除成员和撤销邀请。
- 被移除成员的现有会话必须尽快失去 Project 访问权。

### FR-COLLAB-004：实时同步

状态：规划。

- 首次进入使用 REST 获取完整状态。
- 后续通过 Project WebSocket 接收版本、文档、批注和成员事件。
- 每个事件带递增序号。
- 断线重连携带最后事件序号；无法补发时重新拉取完整状态。
- WebSocket 只用于通知，不作为事实存储。

### FR-COLLAB-005：多人批注和文档关系

状态：规划。

- 所有成员看到同一套云端 Document Binding 和 Annotation。
- Editor 新增内容后，其他在线成员无需刷新即可看到。
- 权限检查必须在服务端执行，不能只隐藏前端按钮。

## 6.9 图谱版本与发布

### FR-VERSION-001：不可变版本

状态：规划，当前本地已有基础 Graph Version。

每次分析生成独立版本，至少记录：

- Version ID、Project ID、仓库指纹、分支和 Commit。
- Parent Version ID。
- 分析引擎、Skill 和 Contract 版本。
- 创建者和创建时间。
- 产物位置、状态和校验摘要。

### FR-VERSION-002：版本状态机

状态：规划。

状态包括：

| 状态 | 含义 |
|---|---|
| Uploading | Local Agent 正在上传 |
| Validating | 云端校验 Schema、安全和关系完整性 |
| Ready | 校验成功，可激活 |
| Active | 当前 Project 正式版本 |
| Failed | 上传或校验失败 |
| Archived | 历史版本 |

### FR-VERSION-003：激活和回滚

状态：规划。

- 第一阶段只有 Owner 可以激活和回滚。
- 新版本校验失败时继续保留现有 Active Graph。
- 旧 Commit 晚到不得覆盖新 Commit。
- 回滚只切换 Active 指针，不删除历史版本。
- 激活和回滚必须写入审计日志并广播事件。

### FR-VERSION-004：图谱差异

状态：规划。

- 用户应该能够查看新增、删除、修改的模块和关系。
- 差异结果用于文档影响分析和 Stable Entity 迁移。
- AI 可以解释差异，但事实集合必须由版本图谱计算得到。

---

## 7. 关键用户流程

### 7.1 本地首次分析

1. 用户启动 Electron 或本地 Web 开发环境。
2. 用户选择“导入仓库”。
3. Electron 返回经过授权检查的仓库路径。
4. Backend 创建本地 Project。
5. 用户触发分析。
6. Analysis Service 创建 Job 并返回。
7. Direct Understand Engine 运行确定性分析。
8. SSE 持续将阶段和进度推送到 UI。
9. 基础事实图完成后先展示。
10. Codex 对受控批次做语义增强。
11. 校验通过后保存 Graph Version，并设为本地最新版本。
12. UI 加载架构总览和动态 Execution Flow。

### 7.2 模块问答

1. 用户选择代码模块或代码域。
2. Frontend 获取 Entity Context 或 Scope Context。
3. Context 包含关系、成员、证据、文档和批注。
4. 用户在 Chat 输入问题。
5. Backend 保存或复用该实体的 Conversation。
6. Codex 在只读仓库上下文中分析。
7. SSE 返回中间进度。
8. 最终答案按结论、事实、推断和引用分区。
9. 消息保存到本地或云端会话存储。

### 7.3 生成模块文档

1. 用户选中模块或代码域。
2. 用户点击“生成代码文档”。
3. Module Documentation Agent 读取当前图谱上下文和源码证据。
4. Agent 生成文档标题、摘要和正文。
5. 本地 DWS 创建钉钉文档。
6. 系统保存文档 URL、外部 ID 和 Entity 绑定。
7. 文档卡片立即显示在图谱中。

### 7.4 Debug 自动更新文档

1. 用户开启 Debug。
2. Repository Watcher 保存当前 processed Commit。
3. 用户修改代码并创建新 Commit。
4. Watcher 发现 observed Commit 变化。
5. UI 显示代码已变更并强化“重新分析”按钮。
6. 系统计算 Commit Diff 和受影响模块。
7. 重新分析产生新图谱。
8. Document Automation 找到受影响模块文档和必要全局文档。
9. Agent 读取旧文档与新代码证据。
10. DWS 更新文档。
11. UI 弹窗展示每篇文档的更新进度。
12. processed Commit 更新为当前 Commit。

### 7.5 创建协作 Project

1. Owner 登录云端。
2. Owner 创建 Project。
3. Electron 将本地 Project 绑定到云端 Project ID。
4. Local Agent 对当前图谱脱敏和校验。
5. Owner 上传首个 Graph Version。
6. 云端校验并激活。
7. Owner 创建 Editor 或 Viewer 邀请。
8. 协作者登录并兑换密钥。
9. 协作者获得成员身份并加载 Active Graph。

### 7.6 发布新图谱并同步

1. Owner 在 master 创建新 Commit。
2. Local Agent 识别变化并重新分析。
3. 生成 Sanitized Graph Artifact。
4. 上传新版本，状态进入 Uploading。
5. Cloud Backend 二次校验，状态进入 Ready。
6. Owner 激活版本。
7. Project 的 Current Graph Version 原子切换。
8. WebSocket 广播 Graph Activated。
9. 在线协作者加载新图谱；离线协作者下次进入时读取最新版本。
10. 当前选中模块通过 Stable Entity ID 映射到新版本。

---

## 8. 系统架构

### 8.1 当前本地架构

| 层 | 当前组件 | 职责 |
|---|---|---|
| Desktop | Electron Main、Preload | 启动本地 API、目录选择、受限 IPC |
| Frontend | React、Vite、React Flow、ELK | 图谱、详情、Chat、文档、分析进度 |
| Backend | Node HTTP API | 项目、分析、图谱、文档、批注、Chat、SSE |
| Analysis | Understand Anything、Codex | 确定性事实提取与语义增强 |
| Persistence | SQLite | 本地项目、版本、任务、文档、批注和会话 |
| Documents | DWS CLI | 本地创建和更新钉钉文档 |
| Git Automation | Repository Watcher | 监听本地 Commit 并触发文档维护 |

当前本地调用方向：

1. Electron/Browser 调用 `127.0.0.1` Local API。
2. Backend 在本机读取仓库并运行分析。
3. 结果写入本地 SQLite。
4. Frontend 通过 REST 和 SSE 展示。
5. 文档操作由本地已认证 DWS 执行。

### 8.2 联网目标架构

目标系统由以下边界组成：

#### Local Agent

- 只读取授权仓库。
- 运行 Understand Anything 和 Codex。
- 监听授权分支 Commit。
- 生成、脱敏和上传图谱。
- 在第一阶段继续本地执行 DWS 文档操作。
- 只主动连接云端，不向公网暴露本地 API。

#### Cloud Backend

- 用户认证和会话。
- Project、邀请、成员和权限。
- 图谱版本上传、校验、激活和回滚。
- 文档、批注、同步任务和审计。
- WebSocket 实时通知。
- 不读取用户本地仓库，不执行通用 Shell。

#### Web Client

- 协作者登录和加入 Project。
- 查看 Active Graph。
- 查看或编辑文档关系和批注。
- 使用权限允许的 AI Chat。
- 不具备本地目录选择和本地源码读取能力。

#### Cloud Storage

- PostgreSQL/RDS：协作业务数据和版本元数据。
- OSS：较大的 Sanitized Graph Artifact。
- Redis：后续用于异步任务、短期事件和在线状态；第一阶段可不使用。

### 8.3 Agent Harness

Agent Harness 是本地 Agent 的控制层，必须负责：

- 将用户动作转换为固定任务类型。
- 构建最小必要上下文。
- 限制 Agent 工作目录和可用工具。
- 强制只读源码 Sandbox。
- 控制分析循环、超时、重试和取消。
- 校验 Agent 结构化输出。
- 调用脱敏器和 Secret Scanner。
- 记录任务、输入版本、Skill 版本和结果。
- 阻止云端把任意路径或命令转换为本地操作。

Skill 只描述“如何分析”；Harness 决定“能读什么、能调用什么、何时结束、输出能否被系统接受”。

### 8.4 Skill 组成

| Skill | 职责 |
|---|---|
| Understand Anything | 扫描仓库并生成事实知识图谱 |
| Repository Understanding | 约束 VisionOwl 的模块、资源和证据提取规则 |
| Graph Layout | 将图谱组织为可读的代码域、模块和关系布局 |
| Module Documentation | 根据选中模块和证据生成或更新代码文档 |
| Understand Diff | 后续用于解释 Commit 或 Graph Version 差异 |
| Dark Glass Graph UI | 统一图谱视觉、交互和避坑规则，不参与代码事实判断 |

### 8.5 组件部署位置

| 组件 | 当前 | 联网目标 |
|---|---|---|
| Electron | Owner 本机 | Owner 本机 |
| Local Agent Backend | Owner 本机 | Owner 本机，受限模式 |
| Understand Anything | Owner 本机 | Owner 本机或受控 CI |
| Codex | Owner 本机 | 本地优先，云端仅使用已授权上下文 |
| Web Frontend | 本地 | ECS/Nginx 或 Cloud Backend 静态服务 |
| Cloud Backend | 无 | ECS |
| SQLite | 本地 | 继续保存本地状态，不上传 |
| PostgreSQL/RDS | 无 | 云端协作事实源 |
| OSS | 无 | 云端图谱产物 |
| DWS | Owner 本机 | 第一阶段本地，后续钉钉 OAuth 服务化 |

---

## 9. 数据模型

### 9.1 当前本地数据

| 表 | 用途 |
|---|---|
| projects | 本地 Project、仓库路径、分支和最新版本 |
| graph_versions | 图谱 JSON 和 Commit |
| analysis_jobs | 分析任务状态 |
| analysis_events | 分析 SSE 历史事件 |
| annotations | 基础模块批注 |
| documents | 全局或模块文档绑定 |
| conversations | 模块 Chat 会话 |
| messages | Chat 消息和引用 |
| project_automation_settings | Debug、observed Commit 和 processed Commit |

当前 SQLite 可能包含敏感仓库历史，禁止复制到 ECS。

### 9.2 云端核心数据表

| 数据表 | 关键字段 |
|---|---|
| users | id、身份来源、状态、创建时间 |
| sessions | user_id、token_hash、expiry、revoked_at |
| projects | owner_id、name、default_branch、current_graph_version_id |
| project_members | project_id、user_id、role、permissions |
| project_invites | token_hash、role、expiry、max_uses、used_count、revoked_at |
| repositories | fingerprint、provider、remote_identifier、default_branch |
| graph_versions | project_id、commit、parent_id、status、artifact_uri、engine_version |
| stable_entities | project_id、stable_id、kind、state |
| entity_mappings | graph_version_id、stable_entity_id、version_entity_id、confidence |
| entity_overrides | stable_entity_id、用户修正字段、版本和修正者 |
| entity_owners | stable_entity_id、user_id、owner_type、有效状态 |
| documents | project_id、stable_entity_id 或 global_scope、provider、url、sync_status |
| annotations | stable_entity_id、author_id、body、version、deleted_at |
| conversations | project_id、stable_entity_id、created_by |
| messages | conversation_id、role、content、citations、model_metadata |
| sync_jobs | type、source_commit、target_commit、status、result |
| realtime_events | project_id、sequence、type、payload、created_at |
| audit_logs | actor_id、action、target、before、after、created_at |

### 9.3 Sanitized Graph Artifact

允许上传：

- Project ID、仓库指纹、分支和 Commit。
- 分析引擎、Skill 和 Contract 版本。
- Stable Entity ID 和版本实体 ID。
- 模块名称、类型、职责摘要和标签。
- 经过校验的模块关系和执行流。
- Redis、数据库、消息队列和外部服务等结构化资源。
- 仓库内相对路径、符号和必要行号。
- 限量、经过敏感扫描的证据摘录。

禁止上传：

- 完整源代码和大段摘录。
- 本机绝对路径。
- `.env`、Token、AccessKey、密码、证书和 SSH 配置。
- Git 凭证和本机环境变量。
- 未授权仓库的文件名、节点和分析缓存。
- 原始 Agent Prompt、临时文件和未过滤日志。

### 9.4 Stable Entity 迁移

| 代码变化 | 迁移规则 |
|---|---|
| 内容变化、路径不变 | 保留 Stable Entity ID |
| Git Rename | 优先使用重命名证据迁移 |
| 路径变化且语义高度一致 | 以置信度迁移，记录依据 |
| 模块拆分 | 文档进入待确认，可建议挂载到多个新模块 |
| 模块合并 | 汇总文档入口，保留原历史关系 |
| 模块删除 | 标记 Archived，保留历史文档 |

---

## 10. 接口规范

### 10.1 当前 Local API

当前已实现的主要接口能力：

| 能力 | 方法与路径 |
|---|---|
| 健康检查 | `GET /api/health` |
| 项目列表 | `GET /api/projects` |
| 创建项目 | `POST /api/projects` |
| 项目详情 | `GET /api/projects/:id` |
| 当前图谱 | `GET /api/projects/:id/graph` |
| 启动分析 | `POST /api/projects/:id/analyze` |
| 分析任务 | `GET /api/projects/:id/jobs` |
| 分析事件流 | `GET /api/projects/:id/events` |
| 自动化状态 | `GET/PATCH /api/projects/:id/automation` |
| 全局文档 | `GET/POST /api/projects/:id/documents` |
| 模块上下文 | `GET /api/projects/:id/entities/:entityId` |
| 代码域上下文 | `POST /api/projects/:id/scopes/context` |
| 添加批注 | `POST /api/projects/:id/entities/:entityId/annotations` |
| 挂载模块文档 | `POST /api/projects/:id/entities/:entityId/documents` |
| 生成文档流 | `POST .../documents/generate/stream` |
| 更新文档流 | `POST .../documents/refresh/stream` |
| 模块 Chat | `POST /api/projects/:id/chat` |
| 模块 Chat 流 | `POST /api/projects/:id/chat/stream` |

联网前必须将 Local API 改为：

- 仅监听 `127.0.0.1`。
- 要求 Electron 启动时生成的临时 Local Token。
- 校验 Host 和 Origin。
- 删除或封闭任意 `repoPath` 输入。
- 所有 Project 操作执行 Repository Policy。

### 10.2 Cloud API 分组

#### Auth

- 登录、刷新、退出和撤销会话。

#### Project

- 创建、查询、修改和删除 Project。
- 查询当前用户可访问的 Project。

#### Invite 与 Member

- 创建、查询和撤销邀请。
- 兑换邀请。
- 查询、修改和移除成员。

#### Graph Version

- 创建上传会话。
- 上传或确认 OSS 产物。
- 完成上传并触发校验。
- 查询版本和状态。
- 激活和回滚。
- 获取 Active Graph。
- 查询版本差异。

#### Document 与 Annotation

- 查询全局和模块文档。
- 挂载、修改和解除文档。
- 创建、修改、软删除批注。
- 查询和重试同步任务。

#### Realtime

- 建立 Project WebSocket。
- 携带最后事件序号恢复。
- 无法补发时返回需要重新同步的状态。

### 10.3 API 统一要求

- 每个云端接口必须认证用户。
- 每个 Project 接口必须校验成员身份和权限。
- 写接口支持幂等键或业务幂等条件。
- 错误返回稳定错误码、可读消息和 Request ID。
- 路径、命令和权限不能使用非结构化自由字符串跨 Local/Cloud 边界传递。
- 前后端和 Local Agent 共享 `packages/contracts` 中的版本化 Contract。

---

## 11. 状态机与实时事件

### 11.1 Analysis Job

| 状态 | 行为 |
|---|---|
| running | 允许接收阶段事件，UI 展示进度 |
| completed | 保存 Graph Version，UI 加载结果 |
| failed | 保存错误，保留上一有效图谱，允许重试 |

### 11.2 Document Sync Job

建议状态：`queued`、`reading`、`analyzing`、`review`、`publishing`、`completed`、`failed`、`skipped`。

### 11.3 Realtime Event

至少支持：

| 事件 | 触发条件 |
|---|---|
| ProjectMemberJoined | 新成员兑换邀请成功 |
| GraphAnalysisStarted | 新分析任务开始 |
| GraphVersionReady | 图谱校验通过 |
| GraphActivated | Active Graph 切换 |
| DocumentCreated | 文档挂载成功 |
| DocumentUpdated | 文档同步成功 |
| AnnotationCreated | 新批注写入 |
| AnnotationUpdated | 批注修改 |
| SyncJobFailed | 图谱或文档任务失败 |

### 11.4 客户端同步规则

- 客户端首次进入先读取完整状态，再建立实时连接。
- 事件必须按 Project 递增序号排序。
- 收到 Graph Activated 后，保留当前选择并按 Stable Entity ID 映射。
- 用户正在编辑批注时，不得静默覆盖其输入。
- 事件只通知变化，最终状态仍以 REST 和数据库为准。

---

## 12. 安全与隐私要求

### 12.1 威胁模型

系统需要防止：

- ECS 或协作者读取 Owner 未授权本地文件。
- 恶意 Project 请求让 Local Agent 分析任意路径。
- 符号链接、相对路径或编码路径逃逸仓库根目录。
- 图谱或日志携带 AccessKey、Token、密码或绝对路径。
- 邀请密钥泄露后成为永久访问凭证。
- Viewer 通过直接调用 API 越权写入。
- 旧图谱覆盖新图谱。
- 云端镜像误包含本地 SQLite、分析缓存或被分析仓库。

### 12.2 Local Agent 边界

- Local Agent 必须只监听 Loopback。
- Electron 启动时生成高强度随机 Local Token。
- Local API 校验 Token、Origin 和 Host。
- Repository Policy 使用 Real Path 精确匹配授权目录。
- 拒绝指向仓库外部的符号链接。
- Codex 使用只读 Sandbox 和受限工作目录。
- 中间产物只写入专用输出目录。
- 不向云端开放通用文件读取、命令执行或工具代理接口。
- 最终建议在只挂载授权仓库和输出目录的独立进程或容器中运行。

### 12.3 脱敏双重校验

Local Agent 上传前：

1. 绝对路径转换为仓库相对路径。
2. 路径越界检查。
3. Secret Scanner。
4. 删除完整源码、Prompt、日志和本机元数据。
5. JSON Schema、大小和关系完整性校验。

Cloud Backend 接收后再次执行同等校验，不信任客户端声明。

### 12.4 身份和邀请

- 邀请密钥只保存哈希。
- 邀请有有效期和使用次数。
- Access Token 短期有效，Refresh Token 可撤销。
- 成员被移除后，服务端立即拒绝其 Project 请求。
- 删除 Project、角色变更和版本回滚需要二次确认。

### 12.5 部署数据隔离

- ECS 使用全新 PostgreSQL，不复制本地 `visionowl.db`。
- Docker 构建上下文排除 `data`、`.ua`、`.git`、日志、缓存和被分析仓库。
- 当前历史数据库包含其他敏感项目，禁止打包或上传。
- 云端不保存个人 DWS Token、Cookie 或身份文件。

### 12.6 审计

必须记录：

- 邀请创建、兑换和撤销。
- 成员角色变更和移除。
- 图谱上传、激活和回滚。
- 文档挂载、更新和解除。
- 批注删除。
- Project 删除。
- 仓库连接和凭证变更。

---

## 13. 非功能需求

### 13.1 性能

- 已缓存的小型仓库基础图应在可交互等待范围内生成，并持续显示进度。
- UI 在 500 个可见节点和 1500 条关系规模下仍应支持缩放、平移和选择。
- 大图谱需要按代码域折叠、关系聚合或分层加载，不能一次渲染所有函数级节点。
- Chat 和文档生成首个进度事件应在 1 秒内返回。
- WebSocket 事件到在线客户端的目标延迟应小于 2 秒。

具体仓库分析耗时受仓库规模、语言、Codex 和本机性能影响，不设置脱离测试环境的绝对承诺；必须提供阶段耗时指标。

### 13.2 可用性

- 云端图谱校验或新分析失败时，上一 Active Graph 保持可用。
- Owner 离线时，协作者仍可读取已发布图谱和协作数据。
- Local Agent 断开不能导致 Cloud Backend 阻塞。
- 文档更新失败不阻止图谱激活。

### 13.3 一致性

- Active Graph 切换使用数据库事务或条件更新。
- 旧 Commit 不得自动覆盖后继 Commit。
- 批注使用版本号乐观锁。
- WebSocket 断线后通过事件序号或完整状态恢复。

### 13.4 可解释性

- AI 回答包含事实、推断和引用分区。
- 图谱关系可查看证据。
- 图谱版本记录分析器和 Skill 版本。
- 文档自动更新记录来源 Diff 和更新摘要。

### 13.5 可访问性

- 主要按钮提供可读标签或 Tooltip。
- 选中、警告和错误不能只通过颜色表达。
- 键盘能够切换主要控件、搜索和打开模块详情。
- 文本必须满足暗色背景下的对比度要求。

### 13.6 兼容性

- 当前优先支持 macOS Electron。
- 本地 Web 开发模式支持现代 Chromium 浏览器。
- 云端 Web 支持当前主流桌面浏览器。
- Node.js 版本不低于 22.5，Python 不低于 3.10。

### 13.7 可维护性

- Local API、Cloud API 和 Realtime Client 分离。
- Contracts 版本化。
- 分析器、图谱脱敏器、文档 Agent 和 Cloud Backend 各自可测试。
- 业务数据、UI 布局和 Skill 规则不互相硬编码。

---

## 14. 错误处理

| 异常 | 产品行为 |
|---|---|
| 仓库不可读 | 阻止创建或分析，说明具体目录问题 |
| 未授权仓库 | Local Agent 拒绝，不创建任务 |
| 分析失败 | 展示失败阶段和重试，保留上一图谱 |
| Codex 不可用 | 使用确定性基础图，并标注未完成语义增强 |
| DWS 未登录 | 文档操作失败并给出认证指引，不影响图谱 |
| 图谱上传中断 | 版本保持 Uploading，超时清理 |
| 图谱校验失败 | 标记 Failed，不切换 Active Graph |
| 文档同步失败 | 标记 Failed，可单篇重试 |
| Stable Entity 匹配失败 | 文档进入待重新挂载列表 |
| WebSocket 断线 | 自动重连，失败后重新拉取完整状态 |
| 邀请过期或撤销 | 拒绝兑换并返回明确原因 |
| 批注写冲突 | 返回最新版本并要求用户合并 |
| 权限不足 | 返回稳定 Forbidden 错误，不执行副作用 |

---

## 15. 可观测性

### 15.1 Local Agent 指标

- 每个分析阶段耗时。
- 扫描文件数、识别实体数、关系数和证据数。
- Codex 批次数、并发数、失败数和回退数。
- 缓存命中率。
- 文档检查数、更新数、跳过数和失败数。
- Sanitizer 删除字段数和敏感扫描失败数。

### 15.2 Cloud Backend 指标

- API 请求量、延迟和错误率。
- 当前 WebSocket 连接数和重连数。
- 图谱上传、校验、激活和失败数量。
- 文档同步任务积压和失败数量。
- 邀请兑换失败和越权请求数量。

### 15.3 日志要求

- 日志包含 Request ID、Project ID、User ID 和任务 ID。
- 不记录邀请明文、Access Token、源码正文或本机绝对路径。
- 分析和发布关键阶段使用结构化日志。

---

## 16. 当前代码改造范围

### 16.1 Local Agent 改造

| 位置 | 必要改造 |
|---|---|
| `backend/src/server.js` | Local Token、用户选择仓库的运行时校验、所有敏感操作重复鉴权 |
| `backend/src/core/http-utils.js` | 移除 `Access-Control-Allow-Origin: *`，限制 Origin 和 Host |
| `backend/src/core/analysis-service.js` | 分析前执行 Repository Policy |
| `backend/src/core/repository-watcher.js` | 只监听授权 Project、仓库和分支 |
| `backend/src/core/git-repository.js` | Real Path、符号链接和路径逃逸校验 |
| `backend/src/core/codex-agent.js` | 固定只读 Sandbox、最小环境和工作目录 |
| `backend/src/core/module-document-agent.js` | 授权仓库校验和输出 Schema |
| `backend/src/core/store.js` | 只保存本地状态，不承担云端权限数据 |

新增建议：

- `backend/src/security/repository-policy.js`
- `backend/src/security/path-guard.js`
- `backend/src/security/local-auth.js`
- `backend/src/config/local-repositories.js`

### 16.2 Sanitizer 包

新增 `packages/graph-sanitizer`：

- 路径规范化。
- Secret Scanner。
- Artifact 清洗。
- JSON Schema 校验。
- 节点和关系完整性校验。

### 16.3 Cloud Backend

新增 `cloud-backend`，内部模块包括：

- auth
- projects
- invites
- members
- graphs
- documents
- annotations
- realtime
- audit
- storage

Cloud Backend 不依赖本地 `fs` 读取仓库，不提供通用命令接口。

### 16.4 Frontend 拆分

当前统一 API 需要拆分为：

- `local-api`：只访问本机 Local Agent。
- `cloud-api`：用户、Project、邀请、版本、文档和批注。
- `realtime-client`：Project WebSocket 和恢复。
- `session-store`：用户、Token、角色和权限。

浏览器协作者不得看到本地目录选择和本地分析按钮。

### 16.5 Electron

- 启动时生成 Local Token。
- Preload 只暴露固定 IPC。
- 目录选择后先授权再绑定。
- 增加云端登录和 Project 绑定。
- 不把云端字符串直接执行为命令或路径。

### 16.6 部署

新增 `infra`：

- Cloud Backend Dockerfile。
- Demo Docker Compose。
- PostgreSQL Migration。
- Nginx HTTPS 与 WebSocket 配置。
- 健康检查、备份和恢复脚本。
- 严格 `.dockerignore`。

---

## 17. 分阶段交付

### Phase 0：巩固本地版

状态：当前阶段。

范围：

- 完成本地仓库分析、图谱交互、AI Chat、文档挂载和 Debug 自动维护。
- 使用 TestRepo 验证代码结构变化、重新分析提醒和文档正确更新。
- 稳定分析进度和图谱布局。

退出条件：

- 本地闭环测试稳定。
- 当前功能自动化测试通过。
- 不再依赖 M5 运行时 Mock 作为主要产品流程。

### Phase 1：本地安全边界

范围：

- Local Agent Token、Origin 和 Host 校验。
- 用户选择仓库、Repository Policy 和分支绑定校验。
- Path Guard 和只读 Harness。
- Sanitized Graph Artifact。
- 敏感信息和路径逃逸测试。

退出条件：

- Local Agent 无法读取 TestRepo 之外文件。
- ECS 不能下发任意路径和命令。
- 上传产物不含绝对路径或凭证。

### Phase 2：Project 与权限

范围：

- Cloud Backend、用户、Project、邀请和成员。
- Owner、Editor、Viewer 鉴权。
- 全新 PostgreSQL。
- Web 登录和加入 Project。

退出条件：

- 两名用户通过不同邀请加入同一 Project。
- 权限矩阵在服务端生效。

### Phase 3：图谱版本与实时同步

范围：

- 上传会话、Graph Version、校验、激活和回滚。
- OSS 产物。
- WebSocket 和断线恢复。
- Electron Publish Graph。

退出条件：

- Owner 发布后，协作者不刷新即可收到更新。
- 失败版本不影响当前 Active Graph。

### Phase 4：文档与批注协作

范围：

- Stable Entity ID。
- 云端文档关系和批注。
- 文档同步任务和审计。
- 跨图谱版本知识迁移。

退出条件：

- 图谱更新后，保留模块仍显示原文档和批注。
- 低置信度迁移进入人工确认。

### Phase 5：远端仓库自动化

范围：

- GitHub、GitLab 和 Aone Webhook/CI。
- 远端 master 作为正式事实源。
- 远端分析任务、重试和状态页。

退出条件：

- Owner 电脑离线时，远端 master Push 仍可生成新版本。
- Aone 接入满足内部仓库最小权限要求。

---

## 18. 验收标准

### 18.1 本地分析验收

1. 导入 TestRepo 后能够完成分析，不停在中间阶段。
2. 分析过程持续展示阶段和进度。
3. 图谱包含真实代码域、模块、Redis、数据库等资源。
4. 模块和关键关系具有源码证据。
5. 执行流按钮根据图谱生成，不使用项目无关的固定名称。
6. 选中模块可查看上下游、详情、文档和批注。
7. AI 回答区分事实与推断，并提供引用。

### 18.2 图谱 UI 验收

1. 关系标签默认可见且不穿入卡片正文。
2. A 到 B 的有向关系动画方向正确。
3. 双向关系不显示误导性的单向脉冲。
4. 选中和取消选中均可单击完成。
5. 相关节点不被变黑或隐藏。
6. 文档使用高斯模糊磨砂玻璃背景，背后内容不会影响阅读。
7. 任意数量文档都保留正确连接线。
8. 代码域可作为整体被选中和分析。
9. 模块卡片副标题描述用途，不显示无意义目录名或内部 ID。
10. 人工修正不会删除底层源码证据，并能在新图谱版本中继续应用或提示冲突。

### 18.3 文档自动化验收

1. 模块可以生成并挂载真实钉钉文档。
2. 新 Commit 出现后显示明显的代码变更提醒。
3. “重新分析”按钮进入持续、明显的呼吸状态。
4. 重新分析后正确识别受影响模块。
5. 受影响模块文档被更新，未受影响文档不被无意义改写。
6. 架构变化时全局文档被检查并正确更新。
7. UI 显示正在处理的文档、阶段和结果。

### 18.4 联网权限验收

1. Owner 能创建 Project 和不同角色邀请。
2. 邀请过期、撤销或超过次数后无法兑换。
3. Viewer 无法创建批注、挂载文档或上传版本。
4. Editor 可以维护知识，但默认不能激活图谱。
5. 被移除成员无法继续访问 Project。
6. 前端隐藏操作之外，直接 API 调用也被服务端拒绝。
7. Editor 可以维护模块负责人和人工语义修正，Viewer 只能查看。

### 18.5 图谱发布验收

1. 每次上传生成独立 Graph Version。
2. 校验失败版本不会成为 Active。
3. 旧 Commit 晚到不能覆盖新版本。
4. Owner 可以回滚到历史版本。
5. 协作者实时收到 Graph Activated。
6. 断线重连后恢复最新版本。
7. 当前选中模块可以跨版本映射；删除模块显示历史状态。

### 18.6 安全验收

1. 非 TestRepo 路径被 Local Agent 拒绝。
2. TestRepo 内指向外部的符号链接被拒绝。
3. 父目录和编码路径跳转被拒绝。
4. 缺少 Local Token 或来源不允许的请求被拒绝。
5. Artifact 中出现绝对路径、Token 或密码时上传失败。
6. Cloud Backend 无法要求 Local Agent 执行任意命令。
7. ECS 镜像不包含本地 SQLite、仓库、缓存和 DWS 凭证。
8. 所有越权操作有审计记录。

---

## 19. 测试策略

### 19.1 单元测试

- Scanner 和结构提取。
- Stable Entity ID 计算和迁移。
- Path Guard。
- Secret Scanner 和 Sanitizer。
- 权限判断。
- 图谱版本状态机。
- Document Impact Analysis。

### 19.2 集成测试

- TestRepo 分析到图谱保存。
- Commit Diff 到文档更新。
- Local Agent 到 Cloud Graph Upload。
- 邀请兑换到成员访问。
- 图谱激活到 WebSocket 通知。
- DWS 创建、更新失败和重试。

### 19.3 端到端测试

- Owner 导入 TestRepo、分析、发布。
- Editor 加入、批注、挂载文档。
- Viewer 只读访问。
- Owner 提交架构变化并发布新版本。
- 协作者自动看到图谱和文档关系更新。

### 19.4 安全测试

- 路径逃逸、符号链接、越权、Token 泄露和恶意 Artifact。
- WebSocket 跨 Project 订阅。
- 邀请重放和并发超次数兑换。
- OSS 越权访问。
- 日志敏感信息扫描。

---

## 20. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| AI 生成错误模块或关系 | 图谱失真 | 确定性事实优先、证据硬约束、人工修正 |
| 大仓库分析过慢 | 用户认为卡死 | 分阶段进度、基础图先展示、增量分析和缓存 |
| 图谱关系过密 | 无法阅读 | 代码域分层、关系聚合、执行流视图和 ELK 布局 |
| 模块重命名导致文档丢失 | 知识断裂 | Stable Entity ID、Git Rename、低置信度人工确认 |
| DWS 依赖个人登录态 | 自动化不稳定 | 第一阶段本地执行；后续迁移钉钉 OAuth 或服务账号 |
| 云端泄露私有代码 | 严重安全事故 | Local Agent、运行时仓库校验、Sanitizer、双重校验和最小上传 |
| 邀请密钥泄露 | 未授权加入 | 哈希、有效期、次数、撤销和独立成员身份 |
| 多人同时修改批注 | 内容覆盖 | 版本号和乐观锁 |
| 旧版本覆盖新版本 | 团队视图回退 | Commit 继承校验和条件更新 |
| Aone 接入差异 | 远端自动化延期 | 统一 Repository Connector 接口，先用 CI 产物上传 |

---

## 21. 开放问题

以下问题需要在对应阶段开始前定案：

1. 第一版用户登录使用自建账号、钉钉 OAuth 还是企业统一身份？
2. Shared Draft 是否允许 Viewer 查看，还是只对 Owner/Editor 开放？
3. Editor 是否需要可配置的 Publish Graph 权限？
4. 大型图谱放 OSS 时，是否需要按代码域切片加载？
5. 云端 AI Chat 的模型、费用额度和 Project 配额如何控制？
6. 钉钉文档更新默认自动发布还是先进入人工审核？
7. Stable Entity 低置信度阈值如何定义？
8. Aone 第一阶段采用 Webhook、CI 插件还是定时拉取？
9. 远端分析运行在 ECS Worker、CI Runner 还是用户自托管 Runner？
10. 是否需要支持 Project 内自定义图谱布局，并与自动布局分离保存？

---

## 22. 关键决策

1. VisionOwl 的核心是可信代码知识图谱，不是生产运行监控平台。
2. 当前本地分析、图谱交互、AI Chat 和钉钉文档维护继续作为产品基础。
3. Understand Anything 负责确定性事实图，Codex 负责有限语义增强和问答。
4. 执行流必须来自分析结果，前端不能写死某个项目的业务链路。
5. 每次发布生成不可变 Graph Version，由 Owner 控制激活。
6. 邀请密钥只用于加入 Project，不作为永久身份凭证。
7. 云端是协作数据和 Active Graph 的事实源；本地主机是私有源码分析结果的生产者。
8. 文档和批注绑定 Stable Entity ID，不绑定单版临时节点。
9. 完整私有源码默认不上传，只上传经过双重校验的 Sanitized Graph。
10. 当前 Backend 不能直接暴露公网，必须拆分为 Local Agent 和 Cloud Backend。
11. 联网安全测试阶段只允许 TestRepo 的 master 分支。
12. 正式自动更新最终以远端 master Webhook 或 CI 为事实来源。

---

## 23. 完成定义

VisionOwl 达到本 Spec 的完整目标态，需要同时满足：

- 能把授权代码仓库分析为具有源码证据的可交互图谱。
- 能围绕模块完成查询、AI 问答、文档和批注协作。
- 能在 Commit 或远端 master 变化后生成新版本并维护受影响文档。
- 能让 Owner、Editor 和 Viewer 安全地共享同一个 Project。
- 能实时通知图谱、文档和批注变化，并在断线后恢复一致状态。
- 能在不上传完整私有源码、不暴露本地文件系统的前提下完成联网协作。
- 所有版本、权限和知识变更都可追溯、可审核、可回滚。

在满足上述条件后，VisionOwl 才从“个人本地代码图谱工具”完成升级，成为“团队可共享、可信且持续更新的代码知识空间”。
