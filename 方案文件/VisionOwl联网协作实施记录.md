# VisionOwl 联网协作实施记录

## 本轮结果

本轮完成了联网协作第一阶段闭环。VisionOwl 现在由本地 Electron 与独立 Cloud Backend 组成：本机负责授权仓库分析，云端只接收经过脱敏和双重校验的图谱 JSON，并保存团队协作数据。

## 已完成

| 能力 | 实现结果 |
|---|---|
| 本地安全边界 | 仓库路径和分支精确授权，Local API 仅监听 Loopback，并使用随机 Local Token 校验请求 |
| 脱敏图谱 | Graph Sanitizer 删除绝对路径、源码摘录和敏感元数据；本地发布前与云端入库前各校验一次 |
| 云端身份 | 支持注册、登录、Access Token、Refresh Token 轮换、注销和会话撤销 |
| Project 协作 | 支持创建 Project、一次性邀请、Owner/Editor/Viewer 权限、成员管理和邀请撤销 |
| 图谱版本 | 支持上传不可变版本、激活、版本列表和重新激活旧版本完成回滚 |
| 文档与批注 | 支持全局/模块文档和模块批注的共享、编辑、删除与权限限制 |
| 实时同步 | 使用一次性 WebSocket Ticket、事件游标和断线重连同步图谱、成员、文档与批注事件 |
| 云端存储 | 提供 PostgreSQL Schema、迁移锁、迁移版本记录、JSONB 图谱、审计日志与 RDS SSL 配置 |
| Electron 接入 | 支持本地分析/团队云端切换、Cloud API 地址配置和系统安全存储加密会话 |
| 部署交付 | 提供严格白名单 Docker 镜像、演示/正式 Compose、Nginx 网关、健康检查和 ECS/RDS 手册 |

## 验证结果

| 验证项 | 结果 |
|---|---|
| 本地后端自动化测试 | 36 项通过 |
| Cloud Backend 自动化测试 | 5 项通过，覆盖权限、邀请、图谱发布、实时事件、脱敏拒绝、令牌轮换和 RDS TLS 配置 |
| 前端 TypeScript 与生产构建 | 通过 |
| 浏览器协作流程 | 完成注册、创建 Project，WebSocket 状态显示 `CLOUD LIVE` |
| Docker Compose 与 ECS | 配置检查通过，并已在 114.55.60.94 完成容器构建、数据库迁移和健康检查 |

## ECS 实机部署

| 项目 | 结果 |
|---|---|
| 公网入口 | https://114.55.60.94，健康检查返回 `visionowl-cloud` 与 `store=postgres` |
| 容器 | PostgreSQL 16、Cloud Backend、Nginx Gateway 均运行正常，Cloud Backend 与 PostgreSQL 健康检查通过 |
| 网络边界 | 容器网关只监听 127.0.0.1:8080；17800 与 5432 未映射到宿主机；公网由宿主 Nginx 443 代理 |
| HTTPS | 使用 Let's Encrypt shortlived 公网 IP 证书，Certbot 5.4 续期演练通过 |
| 自动续期 | `visionowl-cert-renew.timer` 已启用，每 12 小时检查并在续期后重载 Nginx |
| 协作闭环 | Owner/Viewer 注册、Project 创建、邀请兑换、图谱上传激活、Viewer 读取及 WebSocket 成员加入事件全部通过 |

## 当前边界

- 源代码、SQLite、DWS 身份和本地 Agent 不上传 ECS；Cloud Backend 没有读取本机路径、执行命令或 Clone 仓库的接口。
- 当前图谱以 PostgreSQL JSONB 保存，上限 5 MB；大规模版本归档后再引入 OSS。
- 云端 AI Chat 与钉钉正文写入仍由持有源码和授权的本地 Agent 执行，Cloud Backend 只同步其结果元数据。
- Electron 签名、安装包分发、自动更新，以及分析进程的容器级只读隔离属于后续发行与安全加固工作。

具体部署步骤见《VisionOwl 云端部署手册》。
