---
name: repository-understanding
description: 分析源码仓库、生成模块摘要、回答模块相关问题。所有结论只基于确定性代码事实（路径 / 导入 / 符号 / 配置字面量 / git 元数据），区分证据与推断并引用行号，只读不执行不修改仓库。Use when the user asks to analyze or explain a repository, map modules and their dependencies, produce module or architecture summaries, trace a flow across modules, assess change impact, or answer questions like "这个模块负责什么" / "谁依赖它" / "数据写到哪里" / "改这里会影响什么".
---

# Repository Understanding

把仓库当作**证据集合**，不是想象空间。每一条结论都必须能指回某个文件的某几行、某条 manifest 声明，或某条 git 元数据。找不到证据时，正确的输出是"未发现"，而不是一个听起来合理的补全。

## 八条不可让步的约束

1. **确定性事实优先** — 只使用：文件路径、import/require/include 声明、符号定义与引用、manifest 与 lockfile 声明、配置与常量字面量、git 元数据。目录名的直觉、命名相似性、"这类项目通常都有"，都不是事实。
2. **不臆造节点与边** — 图谱里没有的模块和关系一律不写。不要为了让架构图"完整"而补一条缺失的依赖，也不要把设想中的分层画成实际存在的模块。
3. **证据与推断分离** — 每条陈述标注 `[事实]` 或 `[推断]`。`[事实]` 必须附 `path:line`；`[推断]` 必须附依据、置信度，以及"用什么可以证实或推翻它"。
4. **只读** — 不执行代码、不构建、不安装依赖、不改动被分析仓库（包括 git 写操作、格式化、生成文件）。
5. **保留仓库边界** — 仓库外的一切是 `external` 节点。跨仓库连线只能由具体物证建立（声明依赖、字面量地址、共享 IDL/proto、submodule、vendor 路径），**绝不靠包名或前缀相似猜测**。
6. **关系必须归类** — 只用 `imports` / `calls` / `reads` / `writes` / `pushes` / `pops` / `dispatches` / `reports`，并逐条标注 `static` 还是 `runtime`。
7. **基础设施按真实边界建模** — 节点是真实实例（`mysql:eventhub`、`redis:cache`、`sls:app-logs`），不是客户端文件，也不是笼统的"数据库层""消息中间件"。
8. **模块摘要写职责** — 说清它维护什么状态、执行什么规则、对外承诺什么、不负责什么。罗列文件名不算职责描述。

## 只读边界

**允许**：读文件、列目录、glob、grep/ripgrep、符号查找；只读 git —— `rev-parse`、`ls-files`、`log`、`show`、`blame`、`diff`、`shortlog`、`grep`、`cat-file`、`branch --list`、`tag --list`、`submodule status`、`config --get`。

**禁止**：`npm/pnpm/yarn/mvn/go/pip` 的 install / build / test / run；执行仓库内任何脚本或二进制；`git add/commit/checkout/switch/stash/clean/fetch/pull/rebase`（查历史用 `git show <rev>:<path>`，不要切工作区）；改写、格式化、新增仓库内文件；对代码中出现的地址发起网络请求。

分析产物默认只回到对话里。需要落盘时，先确认路径，且不写入被分析的源码树。

## 工作流

### Phase 0 — 固定仓库边界与快照

```bash
git rev-parse --show-toplevel        # 仓库根，多仓库时逐个确认
git rev-parse --short HEAD           # 快照 commit
git status --porcelain               # 是否有未提交改动
git submodule status                 # 每个 submodule 是独立仓库边界
git ls-files                         # 受版本控制的真实文件集
```

用 `git ls-files` 而不是全盘遍历：它天然排除构建产物、缓存、`node_modules`、本地垃圾文件，避免把生成代码当成源码分析。

在输出开头声明快照：仓库根、commit、工作区是否干净、纳入分析的文件数。工作区不干净时说明"分析基于当前工作区文件而非 HEAD"。

### Phase 1 — 建立模块清单（只收 declared unit）

模块的合法来源，按优先级：

1. **构建/包声明** — `package.json`（含 `workspaces`）、`pnpm-workspace.yaml`、`go.mod`、`pom.xml` 的 `<modules>`、`settings.gradle` 的 `include`、`Cargo.toml` workspace、`pyproject.toml`、BUILD/BAZEL 文件。
2. **显式公共入口** — `src/index.ts`、`__init__.py`、`mod.rs`、`api/`、`package-info.java` 等对外收口点。
3. **仓库文档中显式声明的边界** — README / docs 里写明的模块划分（引用文档行号，并与代码交叉验证；文档与代码冲突时**以代码为准**并把冲突报出来）。
4. **部署单元** — Dockerfile、compose service、chart、entrypoint。

**没有上述任何一种声明的目录，是"目录"不是"模块"。** 它可以作为分组出现在报告里，但不得升格为模块节点。

每个模块登记：`id`、声明来源 + 行号、根路径、公共入口文件、语言/运行时、所属部署单元。

### Phase 2 — 提取关系

从公共入口和 manifest 依赖出发，沿 import 图走，逐条产出边：

```
{ from, to, type, binding: static|runtime, evidence: "path:line", symbol, channel, note }
```

`channel` 为 runtime 边必填：决定绑定的常量、配置键或环境变量。

解析规则：import 路径 → 目标模块，依据 workspace 包名、`tsconfig` paths、go module path、Maven 坐标、Python 包名。**解析不出来就记 `unresolved`，不要按目录名相似度归并。** 详细判定规则、多语言证据形态、pushes/pops 配对条件见 `references/relationship-taxonomy.md`。

| 关系 | 含义 | 典型证据 | 默认绑定 |
|---|---|---|---|
| `imports` | 静态引入另一模块的公开入口 | `import { x } from '@app/b'` | static |
| `calls` | 调用另一模块导出的符号 | 调用点 + 符号可解析到对方导出 | static |
| `reads` | 从存储或外部资源读取 | `SELECT`、`GET`、`hget`、`readFile`、HTTP GET | 字面量 static / 动态拼装 runtime |
| `writes` | 写入或变更存储 | `INSERT/UPDATE/DELETE`、`SET`、`hset`、写文件 | 同上 |
| `pushes` | 向队列/流/主题追加消息 | `XADD`、`LPUSH`、`publish`、`send` | runtime |
| `pops` | 从队列/流消费 | `XREADGROUP`、`BLPOP`、`subscribe`、consumer loop | runtime |
| `dispatches` | 把工作交给另一执行上下文 | 路由注册、RPC/HTTP client 调用、cron 声明、handler 注册表 | runtime |
| `reports` | 向观测/统计/审计汇聚点写出指标、日志、埋点 | metrics counter、日志/SLS SDK、统计 use case | 声明 static / 生效 runtime |

**static 与 runtime 的判定**：能靠读源码证明的（import、可解析的调用、字面量 SQL/key）是 static；只在执行期成立的（消息收发配对、依赖注入选择的实现、配置决定的目标、字符串拼出的表名/topic）是 runtime。runtime 边必须记录**绑定机制**和**决定它的配置项或常量**；绑定标识不是字面量时标 `runtime:unresolved`，并且不得合并进静态图当成确定依赖。

### Phase 3 — 基础设施建模

节点身份 = `(kind, instance)`，instance 来自连接配置或环境变量名，不是来自使用它的文件。表/键前缀/流/topic/logstore 是该节点下的**子资源**。同一实例被多处使用时仍是一个节点，用不同关系与子资源区分，不要按用途拆成多个假实例；反过来，两个真实独立实例也不要因为都叫 "redis" 就合并。子资源名不是字面量时记 `resource:unresolved`。规则与各 kind 的识别形态见 `references/infrastructure-model.md`。

### Phase 4 — 交付

三种形态，模板见 `references/output-templates.md`：

- **模块摘要** — 单模块或全仓库逐模块。
- **仓库总览** — 快照 + 模块清单 + 关系图 + 基础设施边界 + 覆盖率声明。
- **定向问答** — 只回答被问的问题，附证据与未知项。

任何形态都要附**覆盖率声明**：检查了哪些文件/入口、哪些区域未覆盖、哪些边 `unresolved`。不要让读者以为一次抽样是全量结论。

## 证据格式

以下示例取自本仓库（EventHub，按 commit `0eb48d1` 核实），示范格式的同时也示范了行号必须真实：

```
[事实] Booking 在创建预订前经 UserAccessReader 接口校验用户下单资格。
  证据 modules/booking/src/create-booking.ts:23 调用 assertCanBook；
       该接口为 type-only 引入（create-booking.ts:4），实现由组装根注入

[推断] API 进程发布的领域事件与 Worker 消费的是同一条 Redis 流。（置信度：高）
  依据 发布与消费共用 RedisEventBus 的同一字段 this.stream，默认值
       "eventhub:domain-events"（packages/event-bus/src/redis-event-bus.ts:18,22,37-42）；
       两个组装根均未覆盖该默认值（apps/api/src/context.ts:45、apps/worker/src/context.ts:35）
  证实方式 确认两进程的 REDIS_URL 在部署环境中指向同一实例与 db 编号
```

行号必须来自实际读到的内容，禁止估算。范围引用写 `path:start-end`。**编一个看起来合理的行号，比不给行号更糟**——它把臆造伪装成了证据。

## 模块摘要怎么写

写"它对系统承诺了什么"，不是"它由哪些文件构成"。

✗ `包含 create-booking.ts、cancel-booking.ts、booking-repository.ts 三个文件，还有测试。`

✓ `维护预订的生命周期状态机：校验座位余量与用户下单资格后创建待支付预订，并在支付完成或取消时推进状态并释放座位。座位余量的真值不在本模块，由 Catalog 持有。`

每份摘要包含：边界与声明来源、职责（1–3 句领域语言）、对外契约（导出符号及语义）、上游/下游（带关系类型）、数据所有权（它**写入**哪些子资源）、明确的"不负责什么"、证据清单。"不负责什么"能有效阻止读者把邻居模块的能力误记到它头上。

## 回答模块问题

先归类问题，再按类型给答案骨架：

- **"这个模块做什么"** → 职责 + 对外契约 + 数据所有权。
- **"谁依赖它 / 它依赖谁"** → 分 `static` 与 `runtime` 两组列出边，各带证据；runtime 组说明绑定机制。
- **"改它会影响谁"** → 从被改符号出发做引用闭包：直接引用者 → 传递引用者 → 契约面（HTTP 路由、消息 schema、数据库列）。契约面变化单独标出，因为它会越过仓库边界。
- **"数据存在哪"** → 落到 `(kind, instance, 子资源)`，并指出谁写谁读。
- **"某流程怎么跑通"** → 按调用顺序串边，每步一条证据；遇到 runtime 断点（消息、注入、配置选择）显式标注"此处为运行时绑定"，不要用一条实线糊过去。

## 不确定时怎么办

- 符号解析不到 → 记 `unresolved`，说明卡在哪（动态 import、反射、代码生成、缺 tsconfig paths）。
- 只有一半证据 → 报告已确认的那一半，明确另一半缺什么。
- 文档与代码冲突 → 以代码为准，并把冲突作为发现之一报出来。
- 需要执行才能确认 → 说明"需运行时验证"，不要自己去跑。
- 仓库过大 → 优先 manifest + 入口 + 部署单元，按调用深度扩展；声明抽样范围，不要假装全量。

## 交付前自检

- [ ] 每条关系都有 `path:line` 证据，行号来自实际读取
- [ ] 每条关系都有 type，且标了 static / runtime
- [ ] 模块节点全部来自 declared unit，没有把普通目录升格
- [ ] 没有任何依赖是靠名字或前缀猜出来的；跨仓库连线都有物证
- [ ] 基础设施节点对应真实实例，子资源归属正确
- [ ] 摘要写的是职责，没有用文件名充当职责
- [ ] `[事实]` / `[推断]` 已分离，推断都有置信度与证实方式
- [ ] 有覆盖率声明与 `unresolved` 清单
- [ ] 全程只读：未执行、未构建、未修改仓库

## 常见臆造，逐条避免

| 臆造 | 为什么错 | 正确做法 |
|---|---|---|
| 补一个"应该有"的 service / 分层 | 图里没有的节点就是不存在 | 只登记 declared unit |
| 因为包名前缀相同就连跨仓库依赖 | 名字不是依赖 | 找 manifest 声明或字面量地址，否则 `external:unresolved` |
| 把"数据库"画成一个节点 | 抹掉了真实实例边界 | 按 `(kind, instance)` 拆分，子资源挂在下面 |
| 把消息生产者到消费者画成直接调用 | 混淆 static 与 runtime | 分成 `pushes` / `pops`，并给出配对常量 |
| 把接口的某个实现当成唯一实现 | 注入目标由组装根决定 | 列出全部实现，指出选择点（配置/环境变量）|
| 摘要写成文件清单 | 没有传达职责 | 写状态、规则、对外承诺 |
| 用 commit message 当架构结论 | 提交信息是意图不是事实 | git 元数据只用于变更热点与归属，且标注来源 |
