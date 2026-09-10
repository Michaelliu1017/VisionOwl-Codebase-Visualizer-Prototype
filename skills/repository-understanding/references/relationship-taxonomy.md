# 关系分类规则

八种关系类型的判定标准、证据形态、绑定强度。**只用这八种**；无法归类的现象不要新造类型，记为观察项并说明卡点。

## 边记录结构

```
{
  from:     "<module-id> | <infra-node> | external:<coordinate>",
  to:       "<module-id> | <infra-node> | external:<coordinate>",
  type:     imports | calls | reads | writes | pushes | pops | dispatches | reports,
  binding:  static | runtime | runtime:unresolved,
  evidence: "path/to/file.ext:120-124",
  symbol:   "被引入/调用的符号，或存储子资源名",
  channel:  "runtime 边必填：决定绑定的常量、配置键或环境变量",
  note:     "限定条件，如仅在某分支/某 profile 下成立"
}
```

一条源码位置可以同时产生多条边（例如一次仓储调用既是 `calls` 也是 `writes`）。分别登记，不要合并成一条含糊的"依赖"。

**三类 `unresolved` 的落点**：目标模块解析不出 → 写在 `to`（`to: unresolved`）；子资源名解析不出 → 写在 `symbol`（`resource:unresolved`）；绑定机制解析不出 → 写在 `binding`（`runtime:unresolved`）。任何一类都必须在 `note` 里说明卡点。

---

## imports

**含义**：源文件静态引入另一个模块的公开入口。

**证据**：`import` / `require` / `from ... import` / `#include` / Java `import` / Go import block 的那一行。

**判定要点**
- 必须能把 import 路径解析到某个 declared unit。解析依据：workspace 包名、`tsconfig.json` 的 `paths`、`go.mod` module path、Maven/Gradle 坐标、Python 包名。
- 解析不到 → `to: unresolved`，note 里写清卡点（动态路径、别名缺配置、生成代码）。
- 引入的是对方**内部路径**而不是公共入口（如 `@app/booking/src/internal/x`）时，照实记录并标注"绕过公共入口"——这本身是重要发现。
- 相对路径的模块内引用不产生跨模块边，但用于构建模块内部的符号可达性。

**绑定**：static。

**不算 imports**：类型-only 引入（`import type`）单独标注 `note: type-only`，它不构成运行期依赖；注释或文档字符串里出现的路径。

---

## calls

**含义**：调用另一模块导出的符号（函数、方法、构造器、use case）。

**证据**：调用点行号 + 该符号能解析到对方的导出声明（附导出处行号更佳）。

**判定要点**
- 必须完成符号解析。只看到同名方法就连边是典型臆造——同名符号在不同模块普遍存在。
- 通过接口调用时：边指向**接口所属模块**，binding 为 static；同时登记"实现选择点"（组装根/DI 容器/配置）为一条 `dispatches` 或在 note 里记录候选实现清单。不要直接把边画到某个具体实现上，除非该实现是代码中唯一存在的。
- 反射、字符串路由、装饰器扫描 → binding `runtime:unresolved`，channel 记下决定调用目标的字符串来源。

**绑定**：static（可解析）/ runtime（反射、动态派发）。

---

## reads

**含义**：从存储或外部资源读取数据。

**证据形态**
- SQL：`SELECT`、`find*`、ORM 查询构造、mapper XML 中的 select 语句
- KV/缓存：`GET`、`MGET`、`HGET`、`SMEMBERS`、`EXISTS`
- 文件：`readFile`、`open(...)` 读模式
- 对象存储：`getObject`、`download`
- HTTP/RPC：GET 请求、只读查询接口
- 搜索：`search`、`query`

**判定要点**
- 子资源（表名、键、bucket、索引）是字面量或可解析常量 → binding static，symbol 填真实名字。
- 名字由变量拼接 → binding runtime，channel 记拼接来源；名字完全不可解析 → `resource:unresolved`。
- 读操作发生在仓储/DAO 层时，边的 `from` 是**该仓储所属模块**，并额外登记业务模块 → 仓储模块的 `calls` 边。两级关系都要保留，别把业务模块直接连到表上而丢掉中间层。

---

## writes

**含义**：写入或变更存储状态。

**证据形态**：`INSERT` / `UPDATE` / `DELETE` / `UPSERT` / `TRUNCATE`、`SET` / `HSET` / `SADD` / `EXPIRE` / `INCR`、写文件、`putObject`、POST/PUT/PATCH/DELETE 请求、DDL。

**判定要点**
- 与 `reads` 同一套子资源解析规则。
- 有 `writes` 边的模块是该子资源的**候选所有者**。多个模块写同一子资源要显式指出——这通常是耦合点或所有权含糊的信号，值得单独列出。
- `EXPIRE`、`INCR` 这类既非纯读也非业务写的操作照实归入 `writes`，note 写明语义（TTL 续期、计数器自增）。
- 迁移脚本、init SQL 里的建表语句归入 `writes`，note 标注"schema 定义"，并把它作为子资源存在的权威证据。

---

## pushes

**含义**：向队列、流、主题追加消息或任务。

**证据形态**：`XADD`、`LPUSH` / `RPUSH`、`publish` / `PUBLISH`、Kafka `send`、MQ `sendMessage`、`enqueue`、任务投递。

**判定要点**
- 边的 `to` 是**通道所在的基础设施节点 + 子资源**（如 `redis:bus / stream:domain-events`），**不是**消费方模块。
- channel 必填：流名/主题名的字面量或常量定义位置。
- 消息体 schema 有类型定义时记下类型来源位置，它是跨模块契约的一部分。

**绑定**：runtime。

---

## pops

**含义**：从队列、流、主题消费消息。

**证据形态**：`XREADGROUP` / `XREAD`、`BLPOP`、`subscribe`、consumer group 配置、`@KafkaListener`、poll 循环、worker 主循环。

**判定要点**
- 边的 `from` 是消费方模块，`to` 是基础设施节点 + 子资源。
- **生产者与消费者之间不画直接边。** 只有当两侧的通道标识是同一个字面量或同一个可解析常量时，才可以在报告里描述"端到端路径"，并且必须写成 `A --pushes--> channel --pops--> B` 三段式，附上该常量的定义位置。
- 两侧通道名无法确认同一 → 两条边各自登记，明确写"未能确认为同一通道"。
- 消费后的分发（按事件类型路由到不同 handler）另记 `dispatches` 边，channel 填事件类型常量。

**绑定**：runtime。

---

## dispatches

**含义**：把工作交给另一个执行上下文，中间没有直接的函数调用关系。

**覆盖场景**
- HTTP/RPC 客户端调用另一个服务（`to` 是 external 节点或另一部署单元）
- 路由注册：URL → handler
- 事件类型 → handler 的注册表 / switch 分派
- 定时任务、cron、delay job 触发
- DI 容器把接口绑定到具体实现（选择点）
- 子进程 / 线程池 / worker 派发

**判定要点**
- channel 必填：路由路径、事件类型常量、cron 表达式、配置键。
- 目标在仓库外时：只有存在字面量 host/URL、声明依赖、共享 IDL 时才连到具体 external 节点；否则 `external:unresolved` 并附出现该地址的配置位置。
- 路由表是把 HTTP 契约面映射到内部模块的关键证据，做影响面分析时必须走这条边。

**绑定**：runtime。

---

## reports

**含义**：向观测、统计、审计类汇聚点写出指标、日志、埋点或统计记录。

**证据形态**：metrics counter / gauge / histogram、tracing span、日志 SDK（如 SLS producer）、审计事件、专门的统计/报表 use case 调用。

**判定要点**
- 与 `writes` 的区别：`reports` 的目标是**观测或统计聚合面**，不是业务真值。业务状态写入永远归 `writes`。判不准时看该数据是否被业务逻辑读回做决策：会 → `writes`，只用于展示/告警/分析 → `reports`。
- 目标是外部观测平台时，节点按真实实例建模（如 `sls:app-logs`），子资源填 project/logstore/metric 名。
- 目标是仓库内的统计模块时，`to` 填该模块，同时它自己对存储的 `writes` 边照常登记。

**绑定**：调用点 static，实际投递 runtime。两者都写进 note。

---

## static 与 runtime 的分界

| 现象 | 绑定 | 必须记录 |
|---|---|---|
| import / 可解析的调用 | static | 证据行号 |
| 字面量 SQL、字面量 key | static | 子资源名 |
| 常量拼接且常量可解析 | static | 常量定义位置 |
| 变量/配置拼接的资源名 | runtime | 拼接来源、配置键 |
| 消息生产与消费 | runtime | 通道常量 |
| DI / 工厂 / 策略选择 | runtime | 选择点位置 + 决定它的配置或环境变量 |
| 反射、动态 import、注解扫描 | runtime:unresolved | 卡点说明 |
| 仅在某 profile / feature flag 下成立 | runtime | 开关名与默认值 |

**硬规则**：runtime 边不得在图里与 static 边混成同一种线。渲染图形时用不同线型，文字报告中分组列出。runtime 边缺 channel 就是不合格的边——要么补上，要么降级为观察项。

## 仓库边界与 external 节点

- `external` 节点的 id 用**声明坐标**：`external:npm/@acme/sdk`、`external:maven/com.acme:client`、`external:http/api.example.com`。
- 允许建立跨仓库边的物证，仅限：manifest/lockfile 中的声明依赖、代码或配置中的字面量地址、共享 proto/IDL/schema 文件、git submodule、vendor 目录。
- **不允许**的推断：包名前缀相同、目录名相似、"这个 SDK 应该对应那个服务"、凭记忆认定某个包属于某个已知仓库。
- 只知道有外部调用但不知道对方是谁 → `external:unresolved`，附配置项位置，说明需要什么才能确定（部署配置、服务注册表、环境变量实际值）。
