# VisionOwl Understand Anything 分析加速执行方案

## 一、目标

在保留 Understand Anything 原有分析质量、节点关系规范和增量能力的前提下，消除 VisionOwl 当前多套一层 Codex 编排带来的固定开销。

本次改造遵循以下边界：

- 继续使用 Understand Anything 的扫描脚本、结构提取器、合并脚本、Agent 规则和知识图谱 Schema。
- 不以自定义目录扫描器替代 Understand Anything。
- 确定性事实由程序生成，Codex 只处理摘要、职责、模块命名等语义问题。
- 用户代码只读，分析产物仍写入仓库的 .ua 目录。
- 保留现有分析链路作为回滚路径。

以相同机器和模型为基准，目标如下：

| 场景 | 当前结果 | 优化目标 |
|---|---:|---:|
| 5 文件仓库首次完整分析 | 约 20 分钟 | 90 秒以内 |
| 首次看到基础关系图 | 完整分析结束后 | 3 秒以内 |
| 仓库没有变化 | 约 125 毫秒 | 保持 1 秒以内 |
| 单文件增量分析 | 仍有较多固定阶段 | 60 秒以内 |

## 二、当前问题

VisionOwl 当前通过 runCodex 启动一个新的 Codex 进程，再要求这个 Codex 阅读完整 SKILL.md 并主持七个阶段。

实际链路为：

VisionOwl 后端 → 外层 Codex → Understand Anything Skill → 多个子 Agent → 分析脚本 → 最终图谱

主要开销包括：

1. 外层 Codex 的冷启动、读 Skill、规划和调度。
2. Project Scanner Agent 主要负责调用已有扫描脚本，语义收益有限。
3. File Analyzer Agent 需要自行创建输入文件、执行结构提取脚本并读取结果。
4. Architecture Agent 和 Tour Agent 每次都会临时编写固定用途的图算法脚本。
5. 前端必须等待全部阶段完成后才能看到图谱。
6. 默认流程对小仓库和大仓库采用相同的固定阶段。

## 三、目标架构

改造后的链路为：

代码仓库 → 后端确定性分析 → 基础事实图谱 → Codex 并行语义增强 → 架构命名 → 完整图谱

后台并行补充：

完整图谱 → Tour 生成 → 深度质量审查

后端新增 Understand Engine，内部划分为：

| 模块 | 职责 |
|---|---|
| Preflight | 判断完整分析、增量分析或直接复用 |
| Static Pipeline | 直接运行 Understand Anything 的确定性脚本 |
| Semantic Orchestrator | 并发调用 Codex 补充摘要、标签和语义关系 |
| Architecture Metrics | 计算目录分组、依赖方向、密度和 Fan-in/Fan-out |
| Graph Assembler | 调用原合并脚本并生成完整图谱 |
| Validator | 校验节点、关系、分层和 Tour |
| Analysis Cache | 保存文件结构、语义结果和版本指纹 |

## 四、实施步骤

### 步骤 1：建立性能基线

在现有分析链路中记录每个阶段的开始时间、结束时间、文件数、批次数、Codex 调用次数和产物更新时间。

准备两套固定测试仓库：

- 小仓库：5 到 10 个文件，用于检查固定开销。
- 中型仓库：50 到 100 个文件，用于检查并发、分批和图谱质量。

验收标准：

- 可以准确看到时间花在扫描、文件分析、架构、Tour 还是保存阶段。
- 同一仓库连续运行可以区分首次分析、增量分析和直接复用。

### 步骤 2：后端直接运行确定性脚本

新增 Direct Understand Engine，由后端依次调用：

- scan-project.mjs
- extract-import-map.mjs
- compute-batches.mjs
- extract-structure.mjs
- merge-batch-graphs.py
- build-fingerprints.mjs

后端负责参数、临时目录、退出码、超时、日志和产物检查，不再让外层 Codex 完成这些机械操作。

扫描完成后立即生成第一版事实图谱，至少包含：

- 文件节点
- 文件类型
- 项目内部 Import 关系
- 已确定的函数和类结构

验收标准：

- 不调用 Codex 也能生成可展示的基础图谱。
- 文件清单和 Import Map 与原 Skill 产物一致。
- 脚本失败时明确返回具体阶段和 stderr，不静默降级。

### 步骤 3：将 Codex 缩减为语义分析器

后端先运行 extract-structure.mjs，再把结构化结果直接交给 Codex。

Codex 只负责：

- 文件和函数摘要
- 标签和复杂度说明
- 结构化工具无法确认的 calls、implements、documents 等语义关系

每个批次使用 JSON Schema 约束输出，禁止 Codex 创建不存在的文件节点，Import 关系始终以 extract-import-map.mjs 的结果为准。

批次按照 compute-batches.mjs 的 Louvain 分组执行，最多并发 5 个。小仓库只有一个批次时直接单次完成。

验收标准：

- Codex 不再创建临时文件或执行结构提取脚本。
- 每个分析批次直接返回结构化 JSON。
- 合并后的节点和关系可以通过原 merge-batch-graphs.py。
- Import 关系召回率不得低于旧链路。

### 步骤 4：固化架构与 Tour 图算法

将 Architecture Agent 和 Tour Agent 每次临时编写的算法固化为后端模块。

Architecture Metrics 固定计算：

- 目录分组和节点类型分组
- Fan-in、Fan-out
- 目录内部依赖密度
- 目录间依赖数量和方向
- 跨类型关系
- 部署拓扑和数据链路

Tour Topology 固定计算：

- 入口节点评分
- BFS 阅读顺序
- 高 Fan-in 和高 Fan-out 节点
- 高内聚节点群

Codex 在架构阶段只负责合并、命名和描述 3 到 10 个架构层；在 Tour 阶段只负责把已有顺序写成容易理解的说明。

Tour 不阻塞主图谱发布，基础图谱和架构完成后即可进入工作台。

验收标准：

- 架构指标计算不再产生临时算法脚本。
- 每个文件节点恰好属于一个架构层。
- Tour 只能引用图谱中已经存在的节点。
- 关闭 Tour 生成时仍可正常使用全部核心功能。

### 步骤 5：支持渐进式图谱

分析任务增加以下状态：

| 状态 | 前端行为 |
|---|---|
| scanning | 展示真实扫描进度和文件数量 |
| facts_ready | 显示文件、函数和 Import 基础图谱 |
| enriching | 逐批更新摘要、标签和语义关系 |
| architecture_ready | 应用架构分层和模块名称 |
| completed | Tour、校验和指纹全部完成 |

节点 ID 在所有阶段保持稳定，语义增强只能补充节点属性和关系，不能导致整张图重新布局。

验收标准：

- 用户在分析开始后 3 秒内看到基础图谱或明确的扫描进度。
- 后续语义结果到达时只更新受影响节点。
- 图谱不会因为阶段切换出现整体跳动。

### 步骤 6：文件级缓存与增量更新

缓存键至少包含：

- 文件内容 Hash
- 结构提取器版本
- Agent 模板版本
- 输出 Schema 版本
- Understand Anything 版本

仓库更新后只重新分析：

- 发生变化的文件
- 与其直接相连的一跳依赖文件
- 受到结构变化影响的架构模块

仅注释或文档变化时，不重新进行社区发现；Import、导出符号或目录结构变化时，才重新计算批次和架构层。

验收标准：

- 仓库无变化时直接复用现有图谱。
- 修改一个文件不会重新分析全部批次。
- Skill、Schema 或解析器升级后缓存会自动失效。

## 五、代码改动范围

预计新增或调整以下后端模块：

| 文件或模块 | 改动 |
|---|---|
| core/analysis-service.js | 接入新分析引擎和渐进式事件 |
| core/understand-anything.js | 保留旧链路，增加引擎切换入口 |
| core/direct-understand-engine.js | 编排确定性脚本和语义阶段 |
| core/understand-process.js | 统一执行 Node、Python 子进程 |
| core/semantic-analyzer.js | 执行批次级 Codex 语义分析 |
| core/architecture-metrics.js | 固化架构图算法 |
| core/tour-topology.js | 固化 Tour 图算法 |
| core/analysis-cache.js | 文件级结果缓存和失效判断 |
| schemas | 增加批次、架构层和 Tour 输出 Schema |

前端主要调整：

| 模块 | 改动 |
|---|---|
| AnalysisProgress | 展示真实阶段、批次和耗时 |
| CodeWorkspace | 接收基础图谱和增量更新 |
| 图谱状态管理 | 保持节点位置和选择状态稳定 |

## 六、质量对比

新旧引擎必须在同一仓库上并行生成图谱，并比较：

- 文件覆盖率
- 函数和类节点数量
- Import 关系召回率
- 悬空关系数量
- 重复节点数量
- 架构层覆盖率
- Tour 引用合法性
- 人工抽查的模块职责准确率

速度达标但质量下降时不得默认启用新引擎。

## 七、发布与回滚

增加分析引擎配置：

VISIONOWL_ANALYSIS_ENGINE 可选择 legacy 或 direct。

执行顺序：

1. 默认继续使用 legacy。
2. 在测试仓库上运行 direct，并保存新旧结果对比报告。
3. direct 达到速度和质量标准后改为默认。
4. 保留 legacy 一个迭代周期。
5. 确认稳定后再删除外层 Codex 编排代码。

任何阶段出现图谱质量问题，都可以切回 legacy，不影响已有 .ua 图谱。

## 八、主要风险

| 风险 | 处理方式 |
|---|---|
| Understand Anything 上游更新导致适配失效 | 固定兼容版本并增加脚本级冒烟测试 |
| 并发 Codex 调用占用过多资源 | 默认并发上限为 5，并允许配置 |
| 缓存未及时失效 | 缓存键包含代码、模板、Schema 和工具版本 |
| 渐进更新导致图谱跳动 | 稳定节点 ID，只增量修改属性和边 |
| Agent 输出不稳定 | 使用 JSON Schema，并以静态分析事实为最高优先级 |
| 架构层语义发生变化 | 保留上一版层名称，只有结构明显变化时重命名 |

## 九、完成定义

满足以下条件后，分析加速改造才算完成：

1. 首次分析不再启动一个负责解释完整 SKILL.md 的外层 Codex。
2. 确定性脚本由后端直接调用。
3. 用户可以在完整语义分析结束前看到基础事实图谱。
4. Codex 只处理语义补充、架构命名和说明生成。
5. 小仓库首次完整分析控制在 90 秒以内。
6. 新旧图谱质量对比通过。
7. 增量缓存、失败提示和旧引擎回滚均可正常工作。
