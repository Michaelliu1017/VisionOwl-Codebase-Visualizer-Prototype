# VisionOwl Agent 编排升级方案

## 1. 目标

- 在单个代码扫描 Runner 内，按 `analysis-packets.json` 拆分多个模块分析 Agent 并行执行。
- 使用一个全局汇总 Agent 合并模块结论，生成完整图谱修正与架构文档。
- 按任务角色选择 Qoder 模型，在保证扫描质量的同时控制时间与 Credit。
- Chat 仅更换为低延迟模型，本阶段不改造 Chat Runner 生命周期与会话机制。

## 2. Qoder 模型分工

| 角色 | Qoder 模型 | 原因 |
| --- | --- | --- |
| 模块分析 Agent | `Performance` | 适合跨文件代码理解、架构分析和关系纠错；多个模块并行时比全部使用 Ultimate 更可控。 |
| 全局汇总 Agent | `Performance` | 只负责合并模块结果和关键跨模块链路，限制为 12 轮，避免 Ultimate 高推理成为串行瓶颈。 |
| Chat Agent | `DeepSeek-V4-Flash` | 当前账号已开放，Qoder 将其定位为快速推理模型；比依赖高峰负载的 Lite 更适合作为稳定的低延迟 Chat 配置。 |

已在 ECS 的 `infra-worker-1` 中执行 `qodercli --list-models`，确认当前账号开放 `DeepSeek-V4-Flash`。当前 CLI 没有可用于无头任务的 `--fast` 参数，因此不采用依赖 Fast 开关的 Kimi 配置。上线前仍需用固定问题集记录首字延迟、总耗时和正确率；若后续账号模型列表变化，则退回 `lite`。

新增配置：

```env
QODER_MODULE_MODEL=Performance
QODER_SYNTHESIS_MODEL=Performance
QODER_SYNTHESIS_MAX_TURNS=12
QODER_CHAT_MODEL=DeepSeek-V4-Flash
MODULE_AGENT_CONCURRENCY=3
```

## 3. 目标流程

```text
源码 checkout
  -> Fact Index 与确定性基础图谱
  -> analysis-packets.json
  -> Agent Orchestrator
       -> 模块 Agent A --\
       -> 模块 Agent B ----> 模块结果确定性合并
       -> 模块 Agent C --/          |
                                  v
                         全局汇总 Agent
                                  |
                                  v
             graph-patch.json + ARCHITECTURE.md
                                  |
                                  v
                  确定性 Patch 与质量门禁
                                  |
                                  v
                         发布完整图谱版本
```

## 4. 编排规则

1. Planner 根据现有模块节点生成分析包；过小且强相关的模块可按依赖簇合并，避免为碎片模块浪费一次 Agent 调用。
2. Orchestrator 在同一 Runner 容器内并发启动最多三个 `qodercli` 子进程，而不是创建多个 Docker Runner。
3. 每个模块 Agent 只能读取该分析包的 `allowedFiles`、Fact Index 事实和一层邻接信息；完整上下文通过 `--attachment` 传入，不放入命令行参数。
4. 每个模块 Agent 输出独立的 `module-results/<packetId>.json`，禁止同时写同一个 `graph-patch.json`。
5. 程序先完成去重、Schema 校验和冲突标记，再把精简后的模块结果交给全局汇总 Agent。
6. 全局汇总 Agent 只处理跨模块关系、关键流程、冲突和架构表达，不重新遍历整个仓库。
7. 最终 Patch 必须经过源码证据校验、关系方向检查、关键入口覆盖和流程连续性门禁；失败时回退确定性基础图谱。

## 5. 产物契约

每个模块 Agent 输出：

```text
module-results/<packetId>.json
  moduleSummary
  responsibilities
  interfaces
  dependencies
  proposedOperations[]
  risks[]
  evidence[]
```

全局汇总阶段输出：

```text
graph-patch.json
ARCHITECTURE.md
analysis-summary.json
quality-report.json
```

所有结论必须携带真实文件、行号和 Commit；无证据结论不得进入最终图谱。

## 6. 资源与故障处理

- 初始并发数固定为 `3`，后续按 Runner CPU、内存和 Qoder 限流结果调节。
- 为兼容当前 ECS，代码默认仍为 `2 CPU / 4 GB`；生产压测时建议从 `4 CPU / 8 GB` 起步，并按实际并发和内存峰值校准。
- 单个模块 Agent 失败不终止整次扫描：记录失败分析包，其余结果继续汇总，并在质量报告中标记覆盖缺口。
- 全局汇总 Agent 失败时不直接拼接局部结论，而是回退确定性基础图谱；模块结果仍作为审计产物保留，避免未经全局消歧的关系进入正式图谱。
- 不再运行独立模型复核 Agent；最终 Patch 直接进入确定性 Schema、源码证据与语义质量门禁。
- 每个子进程使用独立输出目录和临时 HOME，防止 Qoder 会话文件及产物互相覆盖。

## 7. 实施顺序

1. 增加模型与并发配置，并为代码分析显式传入 `--model`。
2. 新增 Runner 内的 Agent Orchestrator 和模块结果 Schema。
3. 将单次 Qoder 分析改为并行模块分析。
4. 增加确定性合并器与受 12 轮硬限制的 Performance 全局汇总 Agent。
5. 将现有图谱 Patch 校验器接到汇总产物之后。
6. 使用固定代码仓库比较升级前后的耗时、Credit、模块覆盖率、关系方向正确率和重跑稳定性。

## 8. 验收标准

- 同一次 Runner 日志中可看到至少两个模块 Agent 并行执行。
- 大模块上下文不得再触发 `spawn E2BIG`，模块 Prompt 必须经附件传递。
- 不同 Agent 不共享可写产物文件，结果可单独审计和重试。
- 最终图谱覆盖所有已声明主要模块，关键业务流程连续。
- 每条新增关系均有真实源码证据，错误 Patch 能被门禁拒绝。
- 相同 Commit 重跑的确定性骨架完全一致，语义结果不存在结构性漂移。
- Chat 使用独立低延迟模型，不因扫描模型升级而变慢。
