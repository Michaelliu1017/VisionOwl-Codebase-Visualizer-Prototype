# VisionOwl 联网协作设计方案

## 1. 文档目标

本文设计 VisionOwl 从本地单机应用升级为联网协作应用的整体方案。

目标效果如下：

- 主机可以创建一个 Project，并邀请其他成员加入。
- 每个邀请可以生成独立密钥，并指定权限、有效期和可使用次数。
- 主机分析本地代码并发布新图谱后，所有协作者能够自动看到最新版本。
- 多人可以共同查看架构、挂载文档、添加批注和使用 AI Chat。
- 图谱更新时，原有文档和批注尽可能继续关联到正确模块。
- 私有代码默认不上传，云端主要保存结构化图谱、文档关系和协作数据。

## 2. 背景与问题

当前 VisionOwl 是本地优先的桌面应用：代码扫描、图谱生成、SQLite 数据和钉钉文档操作主要发生在主机上。这种模式适合个人理解代码，但不适合团队协作。

联网后需要解决四个核心问题：

1. 身份问题：谁能够进入 Project，密钥泄露后如何撤销。
2. 权限问题：谁能发布新图谱、修改文档、添加批注或删除项目。
3. 同步问题：主机更新代码后，协作者如何及时看到同一份新图谱。
4. 数据问题：图谱版本变化后，原有文档、批注和模块身份如何保持稳定。

核心设计原则是：云端服务是协作数据的唯一事实源，主机是可信代码分析结果的生产者，协作者是图谱和知识的消费者与共同维护者。

## 3. 产品边界

### 3.1 第一阶段支持

- 用户登录和项目成员身份。
- Project 创建、邀请、加入和退出。
- Owner、Editor、Viewer 三种权限。
- 主机上传结构化图谱版本。
- 协作者实时收到图谱更新通知。
- 云端保存模块文档、全局文档、批注和会话。
- 主机本地 Commit 触发分析并上传结果。
- 图谱版本回滚和更新审计。

### 3.2 第一阶段暂不支持

- 云端直接保存完整私有源代码。
- 多人同时修改同一张图的布局。
- Aone、GitLab 和 GitHub 服务端自动 Clone。
- 跨 Project 共享模块。
- 复杂企业组织和部门权限继承。
- 在线共同编辑钉钉文档正文。

## 4. 总体架构

系统分为本地客户端、云端服务和外部集成三部分。

### 4.1 本地 VisionOwl 客户端

本地客户端继续使用 Electron，并承担以下职责：

- 让主机选择本地仓库和目标分支。
- 调用 Understand Anything 扫描源码。
- 使用 Codex 对模块职责、架构边界和调用链进行语义增强。
- 监听 Git Commit，并计算相邻 Commit 的 Diff。
- 生成结构化图谱产物和变更摘要。
- 使用主机身份将图谱上传到指定 Project。
- 默认不向云端上传完整源码。

### 4.2 VisionOwl 云端服务

云端服务部署在 ECS，并承担以下职责：

- 用户登录、会话和身份认证。
- Project、成员和邀请密钥管理。
- 图谱版本接收、校验、保存、激活和回滚。
- 文档、批注、AI 会话和审计记录保存。
- 通过 WebSocket 向在线客户端推送实时事件。
- 向离线后重新连接的客户端提供最新完整状态。
- 调度文档维护和其他异步任务。

### 4.3 外部服务

| 服务 | 用途 |
|---|---|
| PostgreSQL 或 RDS | 保存用户、项目、成员、版本元数据、文档和批注 |
| OSS | 保存较大的图谱 JSON、分析产物和可选快照 |
| Redis | 保存异步任务队列、短期事件和在线状态，可在第一版后加入 |
| 钉钉开放平台 | 创建或更新钉钉文档 |
| GitHub、GitLab、Aone | 后续通过 Webhook 或 CI 触发远端分支分析 |

### 4.4 本地受限分析器

本地受限分析器不是新的独立产品，而是对当前 VisionOwl 本地分析能力增加强制权限边界。它仍然由 Understand Anything、Codex、Git Watcher 和图谱生成器组成，但不能读取用户任意指定的目录。

当前安全测试阶段只允许分析以下仓库：

- 允许仓库：/Users/liuguoliang/Documents/swe/testRepo
- 允许分支：master
- 默认触发条件：产生新的 Git Commit
- 禁止范围：用户目录中的其他仓库、Documents 其他文件、SSH 配置、环境变量文件和本机凭证

本地受限分析器必须满足以下约束：

1. 本地配置维护 Project ID 到固定仓库目录的映射。
2. 云端只能发送 Project ID、目标 Commit 和固定操作类型，不能发送本地文件路径或 Shell 命令。
3. 分析前使用 Real Path 解析真实目录，并检查它与允许仓库完全一致。
4. 拒绝通过符号链接、相对路径和父目录跳转离开允许仓库。
5. 创建 Project、重新分析、Git 监听、AI Chat 和文档更新都必须重复执行路径校验。
6. Codex 和扫描器使用只读权限运行；需要生成的中间产物写入专用工作目录。
7. 本地 Agent 只主动连接 ECS，不向公网开放本地分析端口，也不接受 ECS 对本机的通用远程控制。
8. 最终应在独立进程或容器中运行，只挂载允许仓库和专用输出目录，不挂载整个用户目录或 Docker Socket。

在该设计下，ECS 可以表达“重新分析这个 Project”，但本地分析器只能把它解析为“重新分析预先授权的 TestRepo”，不能把它解释为“读取任意本地路径”。

### 4.5 脱敏图谱

脱敏图谱是本地分析完成后上传到 ECS 的结构化架构结果。它让协作者能够理解代码结构，但不向云端提供完整源代码和本机敏感信息。

脱敏图谱可以包含：

- Project ID、仓库指纹、分支和 Commit SHA。
- 模块的稳定 ID、名称、类型和职责摘要。
- 模块之间经过源码证据验证的调用、依赖和数据访问关系。
- Redis、数据库、消息队列和外部服务等架构资源。
- 从仓库根目录开始计算的相对文件路径和符号名称。
- 文档、批注与稳定模块 ID 的关联关系。
- 分析引擎版本、Skill 版本和生成时间。

脱敏图谱默认不得包含：

- 完整源代码或大段源码摘录。
- /Users/liuguoliang 等本机绝对路径。
- .env、AccessKey、Token、密码、证书和 SSH 配置。
- Git 凭证、远端仓库认证信息和本机环境变量。
- TestRepo 之外的任何文件名、图谱节点或分析结果。
- AI 分析过程中产生的原始提示、临时文件和未过滤日志。

上传前需要执行以下检查：

1. 将所有文件路径转换为仓库内相对路径。
2. 校验每个路径都位于 TestRepo 内。
3. 使用敏感信息规则扫描摘要、证据和文档元数据。
4. 删除不必要的源码摘录和本机运行信息。
5. 校验图谱 JSON Schema、大小、节点关系和 Project 身份。
6. 使用 TLS 将产物主动上传到 ECS。
7. ECS 再次校验产物，不信任客户端提交的路径和权限字段。

本地分析和联网共享的完整边界为：

1. TestRepo 源码只在本机受限分析器内读取。
2. 本机生成并检查脱敏图谱。
3. ECS 只接收脱敏图谱、文档关系和协作数据。
4. 协作者只能访问 ECS 中的这些结构化数据。
5. 协作者和 ECS 都不能通过图谱接口读取主机其他文件。

当前 VisionOwl 已经具备代码分析和结构化图谱生成能力。用户选择仓库的运行时校验、进程隔离和上传前脱敏属于联网部署安全门槛；Local API 仍不得直接暴露到公网。

## 5. Project 与邀请密钥

### 5.1 Project 创建

Owner 创建 Project 时，云端生成以下信息：

- Project ID：内部稳定标识。
- Project Name：用户可修改的显示名称。
- Owner ID：项目所有者。
- Repository Fingerprint：仓库稳定标识，不包含完整源码。
- Default Branch：默认关注的分支，第一阶段为 master。
- Current Graph Version：当前对所有协作者生效的图谱版本。

### 5.2 邀请密钥的定位

邀请密钥只用于加入 Project，不应作为永久登录密码。

正确流程为：

1. Owner 创建邀请。
2. Owner 指定邀请对应的角色、有效期和最大使用次数。
3. 服务端生成高强度随机密钥，并只向 Owner 展示一次完整值。
4. 服务端只保存密钥哈希。
5. 协作者登录后输入密钥。
6. 服务端验证密钥并创建 Project Member 记录。
7. 后续访问依赖用户登录会话和成员身份，不再依赖原始密钥。

这样可以记录每个成员的操作，也可以单独移除某个成员，而不必让全员更换共享密码。

### 5.3 邀请管理能力

Owner 应能够：

- 创建不同角色的邀请。
- 设置有效期。
- 设置一次性或多次使用。
- 查看已使用次数。
- 立即撤销邀请。
- 移除已加入成员。
- 调整已有成员角色。

## 6. 权限模型

第一阶段使用三种角色即可。

| 操作 | Owner | Editor | Viewer |
|---|---:|---:|---:|
| 查看图谱和模块详情 | 允许 | 允许 | 允许 |
| 查看全局文档和模块文档 | 允许 | 允许 | 允许 |
| 使用 AI Chat | 允许 | 允许 | 可配置 |
| 添加批注 | 允许 | 允许 | 不允许 |
| 修改自己的批注 | 允许 | 允许 | 不允许 |
| 删除他人的批注 | 允许 | 不允许 | 不允许 |
| 挂载和更新文档 | 允许 | 允许 | 不允许 |
| 上传和激活新图谱 | 允许 | 默认不允许 | 不允许 |
| 回滚图谱版本 | 允许 | 不允许 | 不允许 |
| 创建邀请和管理成员 | 允许 | 不允许 | 不允许 |
| 修改 Project 设置 | 允许 | 不允许 | 不允许 |
| 删除 Project | 允许 | 不允许 | 不允许 |

第一阶段建议只有 Owner 能发布图谱。原因是图谱是项目事实基础，允许所有 Editor 覆盖会带来错误仓库、错误分支和旧版本覆盖新版本等风险。

后续可以为特定 Editor 增加 Publish Graph 权限，不必再增加新的固定角色。

## 7. 图谱版本模型

### 7.1 图谱不是直接覆盖

每次分析都生成独立 Graph Version，而不是直接修改当前图谱。

每个版本至少记录：

- Graph Version ID。
- Project ID。
- Repository Fingerprint。
- Branch。
- Commit SHA。
- Parent Version ID。
- 分析引擎版本。
- Skill 版本。
- 创建者。
- 创建时间。
- 状态。
- 图谱产物在 OSS 中的位置。

版本状态包括：

| 状态 | 含义 |
|---|---|
| Uploading | 客户端正在上传 |
| Validating | 服务端正在校验结构和证据 |
| Ready | 校验成功，可以激活 |
| Active | 当前 Project 正在使用 |
| Failed | 上传或校验失败 |
| Archived | 历史版本 |

### 7.2 激活流程

1. 主机上传图谱产物和 Commit 信息。
2. 服务端确认 Project、仓库和分支匹配。
3. 服务端校验实体 ID、关系端点、数据格式和大小限制。
4. 产物写入 OSS，版本元数据写入 PostgreSQL。
5. 新版本进入 Ready。
6. Owner 激活，或在可信自动发布模式下自动激活。
7. Project 的 Current Graph Version 指向新版本。
8. 服务端广播 Graph Activated 事件。

旧版本不能晚到后覆盖新版本。服务端应比较 Commit 继承关系或上传序号，并使用条件更新保护 Current Graph Version。

## 8. 主机更新与协作者同步

### 8.1 本地 Commit 模式

第一阶段沿用当前 Debug 能力：

1. 主机在 master 创建新 Commit。
2. 本地 Repository Watcher 发现 Commit SHA 变化。
3. VisionOwl 计算上一个已发布 Commit 到当前 Commit 的 Diff。
4. Understand Anything 更新结构化图谱。
5. Codex 只分析发生变化或受影响的模块。
6. 客户端生成新 Graph Version。
7. Owner 确认发布，或启用自动发布。
8. 云端激活新版本并通知协作者。

未提交文件不会直接影响共享图谱，避免主机工作区中的中间状态污染团队视图。

### 8.2 本地 Debug 共享策略

本地尚未 Push 的 Commit 可以分为两种状态：

- Private Draft：只在主机本地显示，不上传云端。
- Shared Draft：由 Owner 明确选择后上传，界面必须显示“未推送草稿”标识。

协作者默认只查看 Published 版本。这样既保留调试能力，也不会把临时代码误认为正式架构。

### 8.3 远端分支模式

后续接入 GitHub、GitLab 或 Aone 后，以远端 master 为正式事实源：

1. 代码 Push 到远端 master。
2. Webhook 或 CI 被触发。
3. CI 调用 VisionOwl Analyzer，或者上传预先生成的分析产物。
4. 云端创建并激活新 Graph Version。
5. 所有客户端收到更新。

远端模式不依赖 Owner 电脑持续在线，更适合正式团队使用。

## 9. 实时同步机制

### 9.1 数据读取

客户端首次进入 Project 时通过 REST API 获取：

- Project 基础信息。
- 当前图谱版本。
- 图谱产物下载地址。
- 文档和批注。
- 当前成员权限。
- 最近的同步状态。

### 9.2 实时事件

客户端随后建立 WebSocket 连接，接收以下事件：

| 事件 | 作用 |
|---|---|
| Project Member Joined | 成员加入 |
| Graph Analysis Started | 新分析开始 |
| Graph Version Ready | 新版本完成校验 |
| Graph Activated | 当前图谱切换 |
| Document Created | 新文档挂载 |
| Document Updated | 文档更新 |
| Annotation Created | 新批注产生 |
| Annotation Updated | 批注修改 |
| Sync Job Failed | 分析或文档同步失败 |

WebSocket 只负责通知，不作为唯一数据存储。客户端断线重连后，应重新读取当前 Project 状态，避免遗漏事件。

每个事件应包含递增序号。客户端携带最后接收序号重连，服务端可补发短期事件；如果事件已过期，则要求客户端重新拉取完整状态。

### 9.3 页面更新策略

收到 Graph Activated 后：

1. 页面提示有新图谱版本。
2. 如果用户没有未保存编辑，自动加载新版本。
3. 如果用户正在编辑批注，先保存或提示确认。
4. 保留当前选中模块，并通过稳定模块 ID 定位新版本中的对应模块。
5. 如果模块已删除，显示“模块已不存在”，但保留其历史文档入口。

## 10. 稳定模块身份

模块文档和批注不能只绑定某一版图谱中的临时节点 ID，否则重新分析后容易丢失。

建议引入 Stable Entity ID，计算信息包括：

- Repository Fingerprint。
- 规范化模块路径。
- 模块类型。
- 主要入口符号。
- 可选语义指纹。

更新图谱时进行身份匹配：

| 变化 | 处理方式 |
|---|---|
| 文件内容变化，路径不变 | 保持原 Stable Entity ID |
| 模块重命名或移动 | 通过 Git Rename 和语义指纹迁移 |
| 模块拆分 | 原文档进入待确认状态，建议挂载到多个新模块 |
| 模块合并 | 合并文档入口，但不自动删除原文档 |
| 模块删除 | 标记为 Archived，保留历史信息 |

自动迁移必须记录置信度。低置信度迁移需要 Owner 或 Editor 确认。

## 11. 文档与批注协作

### 11.1 文档数据

云端不需要保存完整钉钉文档正文，第一阶段保存：

- 文档 ID 和 URL。
- 文档标题。
- 关联的 Stable Entity ID，或者 Project Global 标记。
- 创建者和更新时间。
- 最近同步 Commit。
- 同步状态和更新摘要。

模块文档绑定 Stable Entity ID，全局文档绑定 Project。

### 11.2 文档自动维护

新图谱激活后，文档维护流程如下：

1. 根据 Git Diff 和图谱差异确定受影响模块。
2. 找到这些模块挂载的文档。
3. 判断全局架构文档是否受影响。
4. 创建 Document Sync Job。
5. Agent 读取必要代码证据和原文档内容。
6. Agent 生成可审核更新。
7. 通过钉钉接口更新文档。
8. 云端记录更新摘要、Commit 和结果。
9. 向所有客户端广播 Document Updated。

正式联网版本不应依赖某台个人电脑上的 DWS 登录态。第一阶段可以继续由 Owner 客户端执行 DWS 操作并回传结果，后续应改为钉钉开放平台 OAuth 或受控服务账号。

### 11.3 批注并发

批注保存在云端 PostgreSQL 中，使用版本号进行乐观锁控制：

- 创建批注不需要锁图谱。
- 修改时携带当前版本号。
- 如果服务端版本已变化，返回冲突并提示用户合并。
- 删除使用软删除，便于审计和恢复。

第一阶段不需要实现多人同时编辑同一段富文本。

## 12. AI Chat 联网设计

AI Chat 输入包括：

- 当前 Project 和 Graph Version。
- 当前选中模块。
- 邻接关系和执行流。
- 模块摘要和源码证据。
- 挂载文档与批注。
- 当前用户权限。

需要明确一个隐私边界：如果云端没有源代码，协作者只能基于已上传的图谱、摘要、证据片段和文档提问。对于需要读取完整源码的问题，可以采用以下方式：

1. Owner 本地 Agent 执行，适合第一阶段。
2. 经授权上传必要源码片段，适合受控场景。
3. 云端使用仓库只读凭证临时 Clone，适合后续企业部署。

默认推荐第一种，避免为了在线 AI Chat 上传整个私有仓库。

## 13. 数据模型建议

| 数据表 | 主要内容 |
|---|---|
| Users | 用户身份和状态 |
| Projects | Project 配置和当前图谱版本 |
| Project Members | 用户、Project 和角色关系 |
| Project Invites | 邀请哈希、角色、有效期和使用次数 |
| Repositories | 仓库指纹、远端地址标识和默认分支 |
| Graph Versions | Commit、状态、产物位置和分析版本 |
| Stable Entities | 跨图谱版本的稳定模块身份 |
| Entity Mappings | Stable Entity 与版本节点的映射 |
| Documents | 文档链接、挂载位置和同步状态 |
| Annotations | 批注正文、作者和版本号 |
| Conversations | AI 会话和目标模块 |
| Sync Jobs | 图谱分析与文档同步任务 |
| Audit Logs | 发布、权限变更、删除和回滚操作 |

较小图谱可以直接保存在 PostgreSQL JSONB 中。图谱变大后，将完整图谱 JSON 放入 OSS，PostgreSQL 只保存索引、版本和访问地址。

## 14. API 边界建议

### 14.1 Project 与成员

- 创建 Project。
- 查询 Project 列表和详情。
- 创建、查询和撤销邀请。
- 使用邀请密钥加入 Project。
- 查询、修改和移除成员。

### 14.2 图谱版本

- 创建上传会话。
- 上传图谱产物。
- 完成上传并触发校验。
- 查询版本列表和状态。
- 激活指定版本。
- 回滚到历史版本。
- 获取当前图谱。

### 14.3 文档与批注

- 查询 Project 全局文档和模块文档。
- 挂载、更新和解除文档。
- 创建、修改和删除批注。
- 查询文档同步任务。
- 手动触发指定文档更新。

### 14.4 实时连接

- 建立 Project WebSocket。
- 根据最后事件序号补发事件。
- 查询当前完整状态用于断线恢复。

所有接口都必须在服务端检查用户是否属于 Project，以及其角色是否允许执行该操作。前端隐藏按钮不能替代后端鉴权。

## 15. 安全设计

### 15.1 身份和密钥

- 邀请密钥至少使用 128 位随机值。
- 数据库只保存邀请密钥哈希。
- 邀请默认设置有效期和最大使用次数。
- 用户登录后使用短期 Access Token 和可撤销 Refresh Token。
- 重要操作要求重新认证或二次确认。

### 15.2 仓库和源代码

- 默认不上传完整源码。
- 图谱产物上传前允许关闭源码摘录，只保留路径和符号。
- 仓库远端地址、文件路径和证据片段也可能敏感，需要按 Project 权限保护。
- 远端仓库凭证必须加密保存，并使用最小只读权限。
- 分析临时目录在任务结束后清理。

### 15.3 操作审计

以下操作必须记录审计日志：

- 邀请创建、使用和撤销。
- 成员角色变更和移除。
- 图谱上传、激活和回滚。
- 文档挂载、更新和解除。
- Project 删除。
- 仓库凭证创建和变更。

## 16. 部署方案

### 16.1 第一阶段最小部署

| 组件 | 部署位置 |
|---|---|
| Web 前端 | ECS 上的 Nginx 或 VisionOwl Node 服务 |
| API 与 WebSocket | ECS 上的 VisionOwl Backend |
| 数据库 | RDS PostgreSQL，Demo 可先使用 ECS PostgreSQL |
| 图谱产物 | OSS，Demo 小图谱也可暂存在数据库 |
| HTTPS | 阿里云负载均衡或 Nginx 证书 |
| 本地分析器 | Owner 的 Electron 客户端 |

第一阶段可以暂不引入 Redis。异步任务量增加后，再将分析、文档更新和通知任务放入 Redis 队列。

### 16.2 服务拆分演进

初期保持一个 Node.js 服务，内部按模块分层：

- Auth Service。
- Project Service。
- Graph Version Service。
- Collaboration Service。
- Document Sync Service。
- Realtime Gateway。

只有当任务耗时或并发明显增长时，再拆出 Analysis Worker 和 Document Worker，避免 Demo 阶段过早复杂化。

## 17. 异常处理与一致性

| 异常 | 处理策略 |
|---|---|
| 图谱上传中断 | 版本保持 Uploading，超时后清理 |
| 图谱校验失败 | 保留当前 Active 版本，不影响协作者 |
| 旧 Commit 晚到 | 拒绝自动激活，允许作为历史版本保存 |
| WebSocket 断开 | 重连后重新读取当前状态 |
| 文档更新失败 | 图谱仍可激活，文档任务进入 Failed 并可重试 |
| 模块身份无法匹配 | 文档进入待重新挂载列表 |
| 邀请密钥泄露 | Owner 撤销邀请并移除异常成员 |
| Owner 离线 | 协作者仍可访问云端现有版本，新的本地代码暂不更新 |

## 18. 代码改造清单

本节把前面的系统设计落实到当前 VisionOwl 代码结构中。联网版本必须明确区分本地可信进程和云端公共服务，不能继续由同一个 Backend 同时承担源码读取和公网协作。

### 18.1 现有 Backend 改为 Local Agent

当前 backend 目录保留在主机侧，定位调整为 Local Agent。它负责读取授权仓库、运行分析、维护本地状态和上传脱敏图谱，不能作为公网 API 原样部署到 ECS。

需要修改的现有文件：

| 文件 | 改造内容 |
|---|---|
| backend/src/server.js | 增加 Local API 身份校验；禁止请求直接提交任意 repoPath；所有分析、Chat、文档和自动化接口执行仓库授权检查 |
| backend/src/core/http-utils.js | 删除任意来源 CORS，只允许本地 VisionOwl 页面；增加 Origin、Host 和 Local Token 校验所需响应头 |
| backend/src/core/analysis-service.js | 每次分析前检查 Project 与授权仓库映射，并拒绝未授权路径 |
| backend/src/core/repository-watcher.js | 只监听已授权的 TestRepo 和 master，不根据云端输入切换本地目录 |
| backend/src/core/git-repository.js | 对仓库路径执行 Real Path 校验，拒绝符号链接和目录逃逸 |
| backend/src/core/codex-agent.js | 保持只读 Sandbox；限制工作目录；清理不必要的环境变量；禁止云端传入自由命令和本地路径 |
| backend/src/core/module-document-agent.js | 文档 Agent 只能读取已授权仓库，输出继续经过 Schema 校验 |
| backend/src/core/store.js | 本地只保存授权仓库映射、本地分析任务和同步游标；不承担云端成员和权限数据 |

建议新增：

| 文件 | 作用 |
|---|---|
| backend/src/security/repository-policy.js | 保存并执行 Project ID 到固定仓库路径的授权策略 |
| backend/src/security/local-auth.js | 校验 Electron 启动时生成的临时 Local API Token |
| backend/src/security/path-guard.js | Real Path、符号链接、父目录跳转和允许根目录检查 |
| backend/src/config/local-repositories.js | 测试阶段只登记 TestRepo 和 master |

当前测试配置必须只允许：

- Project：TestRepo 测试 Project。
- 仓库：/Users/liuguoliang/Documents/swe/testRepo。
- 分支：master。
- 其他已有 Project：不得参与监听、分析、Chat、文档更新或上传。

### 18.2 增加脱敏图谱模块

建议新增独立包 packages/graph-sanitizer，供 Local Agent 上传前和 Cloud Backend 接收后共同使用。

主要文件：

| 文件 | 作用 |
|---|---|
| packages/graph-sanitizer/src/sanitize-graph.ts | 删除绝对路径、源码正文、临时字段和本机运行信息 |
| packages/graph-sanitizer/src/secret-scanner.ts | 检查 AccessKey、Token、密码、证书和环境变量内容 |
| packages/graph-sanitizer/src/path-normalizer.ts | 将路径转换为仓库内相对路径，并拒绝越界路径 |
| packages/graph-sanitizer/src/validate-artifact.ts | 校验图谱 Schema、节点关系、大小和 Project 身份 |
| packages/graph-sanitizer/schemas/sanitized-graph.schema.json | 定义允许上传的字段和结构 |

Local Agent 负责第一次脱敏，Cloud Backend 必须再次独立校验，不能信任客户端声称已经安全的数据。

### 18.3 新增 Cloud Backend

新建 cloud-backend 目录，作为部署到 ECS 的独立服务。该服务不依赖 fs 读取用户仓库，也不能接收本地绝对路径。

建议结构和职责：

| 模块 | 主要职责 |
|---|---|
| cloud-backend/src/auth | 登录、Access Token、Refresh Token 和会话撤销 |
| cloud-backend/src/projects | Project 创建、设置、删除和当前版本管理 |
| cloud-backend/src/invites | 邀请密钥生成、哈希、有效期、次数和撤销 |
| cloud-backend/src/members | Owner、Editor、Viewer 成员和权限管理 |
| cloud-backend/src/graphs | 上传会话、图谱校验、版本激活和回滚 |
| cloud-backend/src/documents | 文档链接、挂载关系和同步状态 |
| cloud-backend/src/annotations | 批注创建、修改、软删除和乐观锁 |
| cloud-backend/src/realtime | Project WebSocket、事件序号和断线恢复 |
| cloud-backend/src/audit | 权限、版本、文档和删除操作审计 |
| cloud-backend/src/storage | PostgreSQL、OSS 和后续 Redis 适配器 |

Cloud Backend 只能接收固定结构的业务请求，不提供执行 Shell、读取文件或调用主机任意工具的通用接口。

### 18.4 修改 Electron 桌面层

需要修改 desktop/main.cjs 和 desktop/preload.cjs：

- Electron 启动时生成高强度随机 Local API Token。
- Token 只提供给当前 Electron Renderer 和 Local Agent。
- Local Agent 继续只监听 127.0.0.1。
- 目录选择结果先经过 Repository Policy 授权，再保存 Project 映射。
- 增加云端登录态、Project 绑定和 Publish Graph 调用。
- 不把 Cloud Backend 下发的字符串直接转换为本地路径或命令。
- Preload 只暴露固定 IPC 方法，不暴露 Node.js、文件系统或通用命令执行能力。

### 18.5 拆分前端 API

当前 frontend/src/code/api.ts 同时承载所有请求，需要拆分为三种客户端：

| 建议文件 | 作用 |
|---|---|
| frontend/src/code/local-api.ts | 与 127.0.0.1 上的 Local Agent 通信，携带 Local API Token |
| frontend/src/cloud/cloud-api.ts | 登录、Project、邀请、成员、图谱版本、文档和批注接口 |
| frontend/src/cloud/realtime-client.ts | 建立 Project WebSocket，处理重连和事件序号 |
| frontend/src/cloud/session-store.ts | 保存当前用户、云端会话和 Project 权限 |

前端页面需要增加：

- 登录和退出。
- 创建 Project。
- 创建邀请和输入密钥加入 Project。
- 成员及角色管理。
- 本地 Project 与云端 Project 绑定。
- 图谱发布、版本状态和回滚。
- 云端新版本提示和自动刷新。
- 文档与批注的协作者身份展示。

桌面 Owner 可以使用 Local API 和 Cloud API；普通浏览器协作者只能使用 Cloud API，界面不显示本地目录选择和本地分析入口。

### 18.6 扩展共享 Contracts

在 packages/contracts 中增加以下结构：

- User、Session 和 Role。
- Project Member 和 Project Permission。
- Project Invite 和 Invite Redemption。
- Graph Upload Session、Graph Version 和 Graph Activation。
- Sanitized Graph Artifact。
- Realtime Event 和 Event Cursor。
- Document Sync Status 和 Annotation Version。
- Audit Event。

Local Agent、Cloud Backend 和 Frontend 必须使用同一份 Contract，避免通过非结构化字符串传递路径、命令和权限。

### 18.7 云端数据库与迁移

为 Cloud Backend 新增 PostgreSQL Migration，建立本文第 13 节中的数据表。

本地 SQLite 与云端 PostgreSQL 必须分开：

- 当前 Electron SQLite 只用于本地运行状态。
- ECS 使用全新的 PostgreSQL 数据库。
- 当前 visionowl.db 包含 develop-repo、GoProbe、aidemo 等历史项目，禁止复制、打包或上传到 ECS。
- 当前 .ua、分析缓存、日志和临时输出不得随部署包上传。
- 联网测试数据库中只创建 TestRepo 对应的测试 Project。

### 18.8 文档与 DWS 改造

第一阶段不把个人 DWS 登录凭证放到 ECS：

1. Local Agent 根据 TestRepo 变更生成文档更新内容。
2. 主机本地 DWS 完成钉钉文档创建或更新。
3. Local Agent 只向 Cloud Backend 上报文档 URL、标题、Stable Entity ID、Commit 和同步结果。
4. Cloud Backend 保存元数据并通知协作者。

后续接入钉钉开放平台 OAuth 后，再将 Document Service 放到云端执行。迁移前不得把个人 DWS Token、Cookie 或本机身份文件复制到 ECS。

### 18.9 增加部署目录

建议新增 infra 目录：

| 文件或目录 | 用途 |
|---|---|
| infra/cloud-backend.Dockerfile | 构建不包含本地仓库、SQLite 和分析缓存的云端镜像 |
| infra/docker-compose.demo.yml | Demo ECS 上启动 Cloud Backend 和 PostgreSQL |
| infra/nginx/ | HTTPS、WebSocket 转发、请求大小和安全响应头 |
| infra/migrations/ | PostgreSQL 表结构版本 |
| infra/scripts/ | 初始化、备份、恢复和健康检查 |

镜像构建上下文必须通过 .dockerignore 排除 data、.ua、.git、本地数据库、日志、临时文件和任何被分析仓库。

### 18.10 安全与功能测试

联网前至少增加以下自动化测试：

| 测试 | 验收结果 |
|---|---|
| 非 TestRepo 路径 | Local Agent 拒绝 |
| TestRepo 内符号链接指向外部 | Local Agent 拒绝 |
| 父目录和编码路径跳转 | Local Agent 拒绝 |
| 无 Local API Token | 返回未认证 |
| 非允许 Origin 调用 Local API | 拒绝 |
| Viewer 上传图谱或修改批注 | 返回无权限 |
| Editor 激活图谱 | 默认拒绝 |
| 邀请过期、撤销或超次数 | 无法加入 |
| 脱敏图谱包含绝对路径或 Token | 上传失败 |
| 旧 Commit 晚于新 Commit 上传 | 不得覆盖当前版本 |
| WebSocket 断线重连 | 能恢复到最新版本和事件序号 |
| Cloud Backend 请求本地路径或命令 | Contract 和 Local Agent 同时拒绝 |

### 18.11 联网部署硬门槛

满足以下条件前，不得将当前 Backend 绑定到 0.0.0.0 或暴露到公网：

1. 用户选择的仓库必须通过 Real Path、Git 仓库、命名分支和路径逃逸校验。
2. Local API Token 和 Origin 校验生效。
3. repoPath 只允许通过本地受保护接口绑定，Cloud Backend 不提供文件系统访问能力。
4. 脱敏图谱双重校验通过。
5. Cloud Backend 与 Local Agent 已物理拆分。
6. ECS 使用全新数据库和干净镜像。
7. 用户、Project、邀请和角色鉴权完成。
8. 路径逃逸、越权和敏感信息测试全部通过。

## 19. 分阶段实施

### 阶段 1：云端 Project 与权限

- 将 SQLite 中的协作数据迁移到 PostgreSQL。
- 增加用户、Project、成员和邀请模型。
- 实现 Owner、Editor、Viewer 鉴权。
- 将当前单项目接口改为 Project 范围接口。

验收标准：两个用户可以通过邀请加入同一 Project，并看到一致的现有图谱。

### 阶段 2：图谱版本上传与实时同步

- Electron 增加登录、云端 Project 选择和 Publish 功能。
- 后端实现 Graph Version 上传、校验、激活和回滚。
- 前端通过 WebSocket 接收 Graph Activated。
- 实现断线重连和状态恢复。

验收标准：Owner 发布新图谱后，协作者无需刷新页面即可看到版本更新提示并加载新图谱。

### 阶段 3：文档与批注协作

- 文档和批注转为云端保存。
- 引入 Stable Entity ID 和跨版本映射。
- 实现文档同步事件和批注实时更新。
- 增加操作审计。

验收标准：图谱更新后，未被删除的模块仍能看到原文档和批注。

### 阶段 4：远端仓库自动化

- 接入 GitHub、GitLab 和 Aone Webhook 或 CI。
- 以远端 master Commit 作为正式发布依据。
- 增加远端分析任务、失败重试和状态页面。

验收标准：远端 master Push 后，即使 Owner 电脑离线，Project 也能自动生成并发布新图谱。

## 20. 第一阶段验收用例

1. Owner 创建 Project，并生成 Editor 邀请和 Viewer 邀请。
2. 两名协作者分别加入，服务端记录独立成员身份。
3. Viewer 无法创建批注、上传图谱或修改成员。
4. Editor 可以添加批注和挂载文档，但不能激活新图谱。
5. Owner 分析本地 master 新 Commit，并发布新版本。
6. 两名协作者实时收到图谱更新通知。
7. 协作者刷新或重新登录后仍看到同一 Active 版本。
8. 图谱更新后，已有模块文档和批注继续挂载。
9. Owner 能回滚到上一图谱版本。
10. 被撤销邀请无法继续使用，被移除成员无法访问 Project。

## 21. 关键决策总结

- 密钥用于邀请，不用于永久身份认证。
- 云端服务是 Project、图谱版本、文档和批注的事实源。
- 第一阶段只有 Owner 能发布图谱。
- 每次分析生成独立版本，不能直接覆盖当前图谱。
- 客户端通过 WebSocket 接收通知，通过 REST 获取真实状态。
- 模块知识绑定 Stable Entity ID，而不是单版图谱节点 ID。
- 默认由主机本地分析代码，只上传结构化图谱和必要证据。
- 正式自动更新最终应由远端 master Webhook 或 CI 驱动。

采用该方案后，VisionOwl 可以在不牺牲本地私有代码控制权的前提下，为团队提供统一、可版本化、可追踪并能实时同步的代码知识空间。
