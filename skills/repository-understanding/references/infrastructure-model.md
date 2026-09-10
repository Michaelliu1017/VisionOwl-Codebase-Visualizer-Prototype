# 基础设施建模

基础设施节点代表**真实的资源边界**，不是使用它的代码文件，也不是笼统的技术分层。

## 节点身份

```
<kind>:<instance>
  └── <resource-kind>:<resource-name>   # 子资源
```

- **kind** — 具体技术：`mysql`、`postgres`、`redis`、`kafka`、`rocketmq`、`sls`、`oss`、`s3`、`es`、`mongo`、`zookeeper`、`http`、`smtp`、`fs`。不要用 `db`、`cache`、`mq` 这类抽象名，它们会把不同边界糊在一起。
- **instance** — 来自连接配置：连接字符串中的库名/集群名、环境变量名（`MYSQL_DSN` / `REDIS_URL`）、配置段名、compose service 名、K8s service 名。取最能唯一标识这个资源的那个，并记下它的来源位置。
- **子资源** — `table:`、`key:`、`keyprefix:`、`stream:`、`topic:`、`queue:`、`bucket:`、`index:`、`logstore:`、`metric:`、`path:`。

## 三条分组硬规则

**1. 同一实例只有一个节点。** 同一个 Redis 既做缓存又做分布式锁又做流，仍是一个节点。用不同**子资源 + 不同关系类型**表达用途差异，不要拆成 `redis:cache` 和 `redis:lock` 两个假实例。

**2. 不同实例不得合并。** 两个 MySQL 实例、或同一 MySQL 上两个不同 schema，是两个不同边界。它们的连接配置来自不同项，就分开建节点。判不准时按连接配置项的数量来分。

**3. 客户端代码不是节点。** `RedisClient`、`XxxRepository`、`SlsProducer` 这些是**模块内的实现**。它们参与的是模块 → 基础设施的边，本身不升格为基础设施节点。

## 实例识别流程

1. 找连接配置来源：`.env` / `.env.example`、`application.yml`、compose / K8s manifest、config 模块、常量文件。
2. 逐个连接配置项建节点，登记：kind、instance 标识、配置来源 `path:line`。
3. 找出创建客户端的组装根（composition root / DI 配置 / 工厂），把"哪个配置项 → 哪个客户端实例"的对应关系记下来。**这一步是把子资源正确归属到实例的唯一可靠途径。**
4. 客户端实例传递给了哪些模块，这些模块的存储操作就归到对应节点。
5. 组装链断在动态注入或反射上 → 该节点标 `instance:unresolved`，说明卡点，不要凭 kind 名把所有操作硬塞给某一个实例。

`.env.example` 只是**声明有哪些配置项存在**的证据，不是实际值的证据。用它证明配置项存在，不要用它断言生产环境的真实地址。

## 各 kind 的识别形态

| kind | 连接配置线索 | 操作线索 | 子资源 |
|---|---|---|---|
| `mysql` / `postgres` | DSN、`DATABASE_URL`、datasource 配置 | SQL 字面量、ORM/mapper、migration、init.sql | `table:`、`view:` |
| `redis` | `REDIS_URL`、host/port/db | `get/set/hset/expire/incr`、`xadd/xreadgroup`、`lpush/blpop` | `key:`、`keyprefix:`、`stream:` |
| `kafka` / `rocketmq` | brokers 列表、nameserver | producer `send`、consumer group、listener 注解 | `topic:`、`consumergroup:` |
| `sls`（日志/观测） | project + endpoint + logstore 配置 | producer / appender / 埋点 SDK | `logstore:`、`metric:` |
| `oss` / `s3` | bucket + endpoint | `putObject` / `getObject` / 签名 URL | `bucket:`、`prefix:` |
| `es` | 节点地址 | `search` / `index` / bulk | `index:`、`alias:` |
| `http`（外部服务） | base URL / host 字面量、服务名 | client 调用、路径拼接 | `endpoint:` |
| `smtp` / 短信 / 推送 | provider 配置、API key 名 | send 调用 | `channel:` |
| `fs` | 挂载路径、路径常量 | 读写文件 | `path:` |

同一实例内的 db 编号（Redis `db=1`）、schema 名，作为 instance 标识的一部分保留——它们是真实隔离边界。

## 存储所有权判定

- 对某子资源有 `writes` 边的模块是**候选所有者**。
- 恰好一个模块写 → 该模块是所有者。
- 多个模块写同一子资源 → 报告为**共享写入**，列出全部写入方及证据。不要自行指定一个"主要所有者"。
- 只有读没有写 → 该模块是**消费者**；若仓库内找不到任何写入方，说明"写入方不在本仓库"，并保留仓库边界，不猜是哪个外部系统写的。
- 建表 DDL / migration 是子资源存在的权威证据；只在代码里出现过的表名标注"仅见于查询语句，未见 schema 定义"。

## 图中的呈现

- 基础设施节点与模块节点视觉区分（形状或分区）。
- 消息通道画成显式中间节点：`Producer --pushes--> redis:bus/stream:X --pops--> Consumer`。不要把生产者直接连到消费者。
- 外部服务与仓库内模块分区放置，边界线明确。
- `unresolved` 节点和边照常出现，但标记为未确认，不要为了图好看而删掉——它们正是需要人工确认的地方。
