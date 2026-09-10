# 输出模板

模板 A–C 中的 `<尖括号>` 均为占位符，实际输出必须替换为真实读取到的内容；模板 D 的示例行是已核实的真实证据。

---

## A. 模块摘要

```markdown
## <module-id>

**边界** `<root-path>`｜声明来源 `<manifest>:<line>`｜入口 `<entry-file>`｜运行时 `<language/runtime>`

**职责**
<1–3 句。说明它维护什么状态、执行什么规则、对外承诺什么。用领域词汇，不出现文件名。>

**对外契约**
| 导出符号 | 语义 | 定义位置 |
|---|---|---|
| `createBooking(input)` | 校验后创建待支付预订，返回预订标识与状态 | `src/create-booking.ts:18` |

**上游（谁依赖它）**
- `<module>` --calls--> `createBooking` ｜static｜`<path>:<line>`

**下游（它依赖谁）**
- --calls--> `<module>.<symbol>` ｜static｜`<path>:<line>`
- --writes--> `mysql:<instance>/table:<name>` ｜static｜`<path>:<line>`
- --pushes--> `redis:<instance>/stream:<name>` ｜runtime｜channel `<CONST>`（`<path>:<line>`）

**数据所有权**
- 独占写入：`mysql:<instance>/table:<name>`（`<path>:<line>`）
- 只读消费：`mysql:<instance>/table:<other>`（写入方为 `<module>`）

**不负责**
- <明确不在它职责内、但容易被误认为属于它的事，各附一句归属说明>

**待确认**
- <unresolved 边、需运行时验证的绑定，各说明缺什么>
```

**职责段的写法对照**

| ✗ | ✓ |
|---|---|
| 包含 3 个 use case 文件和一个 repository | 维护预订生命周期状态机，决定何时占用与释放座位 |
| 负责支付相关逻辑 | 记录支付意图并消费网关回调，把成功/失败结果落为终态；不发起扣款，扣款由外部网关执行 |
| 提供工具函数 | 定义跨模块共享的标识符类型与时间语义，无业务规则、无存储访问 |

---

## B. 仓库总览

```markdown
# <repo-name> 仓库分析

## 快照
仓库根 `<toplevel>`｜commit `<short-sha>`｜工作区 `<干净 / 有未提交改动，分析基于工作区文件>`
纳入分析 `<n>` 个受版本控制文件｜submodule `<无 / 列表>`

## 模块清单
| 模块 | 路径 | 声明来源 | 职责（一句） | 部署单元 |
|---|---|---|---|---|

## 关系图
（static 与 runtime 用不同线型；基础设施与模块分区；消息通道为显式中间节点）

## 静态关系
| from | type | to | symbol | 证据 |
|---|---|---|---|---|

## 运行时关系
| from | type | to | channel（决定绑定的常量/配置） | 证据 |
|---|---|---|---|---|

## 基础设施边界
| 节点 | kind | instance 来源 | 子资源 | 写入方 | 读取方 |
|---|---|---|---|---|---|

## 跨仓库边界
| external 节点 | 物证类型 | 证据 |
|---|---|---|
（无物证的一律 `external:unresolved`）

## 发现
- [事实] <结论>｜证据 `<path>:<line>`
- [推断] <结论>（置信度：高/中/低）｜依据 <…>｜证实方式 <…>

## 覆盖率
已检查：<入口、manifest、被追踪的调用深度>
未覆盖：<目录/语言/生成代码>
unresolved：<n> 条边（清单见上）
```

---

## C. 定向问答

```markdown
**结论**
<直接回答被问的问题，一到两句。>

**依据**
- [事实] <支撑点>｜`<path>:<line>`
- [事实] <支撑点>｜`<path>:<line>`

**边界**
<未覆盖到什么、哪些部分是运行时绑定无法静态确认、需要什么才能进一步确认。>
```

只回答被问的问题。不要顺带输出未被索取的全仓库总览。

### 影响面分析的追加结构

```markdown
**直接引用者**（改签名即断）
- `<module>` `<path>:<line>`

**传递引用者**（经 N 跳）
- `<module>` ← `<中间模块>`｜`<path>:<line>`

**契约面**（会越出仓库边界，需协同）
- HTTP `<METHOD> <path>` ｜路由注册 `<path>:<line>`
- 消息 `<stream/topic>` 的字段 `<field>`｜schema `<path>:<line>`
- 数据库 `<table>.<column>`｜DDL `<path>:<line>`

**运行时未确认**
- <反射/动态注入导致无法静态判定的调用点>
```

---

## D. 证据台账

关系较多时单列一份台账，便于逐条复核。以下示例取自本仓库（EventHub，按 commit `0eb48d1` 核实），同时示范了两条规则：业务模块经中间层到基础设施要**两级登记**（#1/#2/#4 是 calls，#3/#5 才是真正碰基础设施的边）；生产与消费**不画直连边**，靠同一通道常量关联。

```markdown
| # | from | type | to | binding | 证据 | channel | note |
|---|---|---|---|---|---|---|---|
| 1 | booking | calls | identity | static | `modules/booking/src/create-booking.ts:23` | — | 经 UserAccessReader 接口（type-only import，:4），实现由组装根注入 |
| 2 | booking | calls | event-bus | static | `modules/booking/src/create-booking.ts:64` | — | 经 EventPublisher 接口发布事件信封 |
| 3 | event-bus | pushes | `redis:REDIS_URL/stream:eventhub:domain-events` | runtime | `packages/event-bus/src/redis-event-bus.ts:22` | this.stream 默认参数（redis-event-bus.ts:18） | XADD；#2 的运行时延续 |
| 4 | worker | calls | event-bus | static | `apps/worker/src/worker.ts:11` | — | 经 EventConsumer 接口 |
| 5 | event-bus | pops | `redis:REDIS_URL/stream:eventhub:domain-events` | runtime | `packages/event-bus/src/redis-event-bus.ts:37-42` | 同 #3 字段 | XREADGROUP，consumer group "eventhub-workers"（worker.ts:11）；与 #3 同通道，同一默认值且两组装根均未覆盖 |
```

## 表达纪律

- 每个断言要么带 `path:line`，要么带 `[推断]` 标记。没有第三种。
- 行号来自实际读取，不估算；范围写 `path:start-end`。
- 不确定就写不确定，并说明缺什么。**"未发现"是合格结论，编一个合理答案不是。**
- 不使用"应该""大概""通常会"来填补证据空缺——那是把推断伪装成事实。
