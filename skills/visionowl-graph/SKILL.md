---
name: visionowl-graph
description: 在 VisionOwl Runner 内基于 Fact Index v2 和不可变 Base Graph 生成可审计的 graph-patch.json。用于补充模块职责、修正有源码证据的节点或关系、增加关键流程视图；禁止直接改写 graph.base.json 或 graph.json。
---

# VisionOwl Graph Patch 契约

你在一次性分析容器中工作。确定性扫描器已经生成：

- `/workspace/out/facts.v2.json`：规范化事实与 Fact ID
- `/workspace/out/symbol-index.json`：符号定义、引用与调用定位
- `/workspace/out/interface-catalog.json`：HTTP、事件和包接口
- `/workspace/out/resource-catalog.json`：数据库、Redis、消息队列、配置和外部服务
- `/workspace/out/diagnostics.json`：静态扫描不能确定的内容
- `/workspace/out/graph.base.json`：不可变的确定性图谱骨架
- `/workspace/out/graph-patch.json`：扫描器生成的空 Patch 模板

你的图谱交付物只有 `/workspace/out/graph-patch.json`。不得修改 `graph.base.json` 或 `graph.json`。

## 核心边界

1. 保留 Patch 模板中的 `schemaVersion`、`baseGraphVersion`、`repositoryId` 和 `commitSha`。
2. 只能通过 `operations` 提交 `add_node`、`add_edge`、`replace_edge`、`suppress_edge`、`update_summary`、`set_architecture`、`add_view`。
3. 每个 operation 都必须有 `operationId`、`reason`、`confidence` 和真实源码 `evidence`；新增或替换的节点、边还必须携带与 Patch 一致的 `repositoryId`。
4. `confidence < 0.65` 的提案不会合入。无法证实的内容不要提交 Patch，可在架构文档中标注【推断】。
5. `add_edge` 的 source 到 target 必须与真实调用点、provider-consumer 或配置方向一致。
6. 不得把名称相似、目录相邻或经验猜测当作关系证据。
7. 单条 evidence 最多 40 行，不复制大段源码，不写入密钥、Token 或完整配置。

## 分析顺序

1. 先读 `graph.base.json`，确认已有节点、边、视图及 `baseGraphVersion` 模板值。
2. 用 `facts.v2.json` 和目录中的 catalog 定位需要补充的模块，不从零遍历仓库。
3. 只读取 Fact evidence 指向的入口、公共符号和一层上下游源码。
4. 为职责不清的模块提交 `update_summary`，摘要说明“负责什么、对外边界、关键约束”。
5. 核对默认架构总览的主次：对运行入口、前后端、Worker、调度器、执行器和关键数据组件使用 `set_architecture`；测试、示例、工具脚本和低价值叶子模块标为 `detail`。主次判断必须同时引用入口、调用、资源或部署证据，不能只看目录名。
6. 只有 Scanner 确实漏掉真实对象时才用 `add_node`；只有源码能证明方向时才用 `add_edge` 或 `replace_edge`。
7. 关键业务流程使用 `add_view`，steps 必须按真实执行顺序引用存在的边。
8. 将无法确定的动态调用保留在 `diagnostics.json`，不要为了让图更完整而猜边。
9. 同步生成 `/workspace/out/ARCHITECTURE.md`，文档可以解释推断，但必须明确标注。

## Patch 结构

`graph-patch.json` 顶层结构如下：

```json
{
  "schemaVersion": "1.0",
  "baseGraphVersion": "保持模板原值",
  "repositoryId": "保持模板原值",
  "commitSha": "保持模板原值",
  "generator": "qoder",
  "skillVersion": "visionowl-graph/2.0.0",
  "operations": []
}
```

职责摘要操作示例：

```json
{
  "operationId": "summary-cloud-api",
  "op": "update_summary",
  "nodeId": "模板中的真实节点 ID",
  "summary": "提供项目、图谱版本与协作权限 API，并将耗时分析任务投递到队列",
  "reason": "路由注册和任务服务共同表明该模块的边界",
  "confidence": 0.96,
  "evidence": [
    { "file": "src/index.ts", "startLine": 20, "endLine": 38, "symbol": "buildServer" }
  ]
}
```

新增流程视图时，`view.nodeIds`、`view.edgeIds` 和 `steps.edgeId` 必须引用 Base Graph 或同一 Patch 先前新增的对象。操作自身仍需携带能证明流程顺序的 evidence。

## 操作选择

| 操作 | 使用条件 | 禁止用法 |
|---|---|---|
| update_summary | 已有节点职责需要语义补充 | 修改节点 ID、kind 或 path |
| set_architecture | 有源码证据支持模块角色和总览主次 | 仅凭名称隐藏或提升模块 |
| add_node | Scanner 漏掉且源码可定位的真实组件 | 用抽象概念填满画布 |
| add_edge | 源码可证明的新关系 | 用命名相似度猜关系 |
| replace_edge | call site 可证明原关系类型或方向错误 | 不说明冲突原因直接覆盖 |
| suppress_edge | 确定性解析器产生可复现的误报 | 因为“不重要”而隐藏事实 |
| add_view | 多个既有关系组成连续业务流程 | steps 断裂或引用不存在的边 |

## 交付检查

- `graph-patch.json` 是合法 JSON，顶层版本和 commit 未变化。
- 每个 operationId 唯一。
- 每条 evidence 文件存在，行号有效；填写 symbol 时能在 Symbol Index 定位。
- 新节点 ID、新边 ID 不与 Base Graph 冲突。
- 新边两端都存在，方向与调用点一致。
- `replace_edge`、`suppress_edge` 指向真实存在的 edgeId。
- `add_view` 不含悬空节点、边或不连续步骤。
- 不直接改动 `graph.base.json`、`graph.json`、Fact Index 与 catalog。

## 成本纪律

全量任务和增量任务的 turn 数由外部硬限制。优先使用索引和 evidence 做定向阅读；增量任务只处理 `impact.json` 标出的模块及一层邻接，不通读整个仓库。
