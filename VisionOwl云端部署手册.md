# VisionOwl 云端部署手册

## 1. 部署结果

部署完成后，系统由两部分组成：

- 每位成员的电脑运行 VisionOwl Electron。源代码分析、Codex、Understand Anything、DWS 和 SQLite 仍在本机。
- 演示部署可在 ECS 运行 Cloud Backend、Nginx 与容器化 PostgreSQL；正式部署建议改用同 VPC 的 RDS PostgreSQL 保存账号、Project、成员、图谱版本、文档关系、批注、事件和审计记录。

Electron 通过 HTTPS 调用 Cloud Backend，并通过 WSS 接收实时事件。Owner 从本地图谱发布脱敏 JSON；其他成员不需要拿到仓库源码，也能看到同一个图谱版本。

Cloud Backend 没有读取路径、执行 Shell、Clone 仓库或控制本地 Agent 的接口。`backend/` 中的本地分析服务不得部署到 ECS，也不得暴露到公网。

## 2. 交付文件

| 文件 | 用途 |
|---|---|
| `cloud-backend/Dockerfile` | 构建仅包含 Cloud Backend 与 Graph Sanitizer 的镜像 |
| `.dockerignore` | 使用白名单排除本地仓库、SQLite、Electron、测试数据和分析日志 |
| `infra/docker-compose.cloud.yml` | 自带 PostgreSQL 的演示环境 |
| `infra/docker-compose.rds.yml` | 连接 RDS PostgreSQL 的正式环境 |
| `infra/nginx/visionowl-cloud.conf` | HTTP、WebSocket、上传大小和登录限流代理 |
| `infra/.env.cloud.example` | 演示环境变量模板 |
| `infra/.env.rds.example` | RDS 环境变量模板 |
| `infra/scripts/cloud-smoke-test.mjs` | 云服务健康检查 |
| `infra/scripts/cloud-collaboration-test.mjs` | 注册、邀请、图谱和 WebSocket 协作闭环测试 |

### 2.1 当前实例

- ECS：114.55.60.94。
- Cloud API：https://114.55.60.94。
- 健康检查：https://114.55.60.94/api/health。
- 当前数据层：ECS Docker Volume 中的 PostgreSQL 16，适合演示与联调；正式数据迁移到 RDS 后再按第 6 节切换。
- 容器网关只绑定 127.0.0.1:8080，公网 443 由宿主 Nginx 终止 TLS；PostgreSQL 5432 和 Cloud Backend 17800 均未映射到宿主机。

## 3. 阿里云资源

### 3.1 ECS

第一阶段一台 2 vCPU、4 GiB 内存的 Alibaba Cloud Linux 3 ECS 足够。ECS 与 RDS 必须位于同一地域、同一 VPC，优先使用 RDS 内网地址。

安全组只开放：

- `22/tcp`：仅允许管理员固定公网 IP。
- `443/tcp`：允许 Electron 客户端访问。
- `80/tcp`：可选，只用于跳转 HTTPS。
- 使用 ALB 时，ECS 的 `8080/tcp` 只允许 ALB 后端访问，不向全网开放。

禁止向公网开放 `17800` 和 `5432`。

阿里云官方的 Docker 与 Compose 安装步骤见 [在 Linux 上安装 Docker 和 Docker Compose](https://help.aliyun.com/zh/ecs/user-guide/install-and-use-docker)。

### 3.2 RDS PostgreSQL

创建 PostgreSQL 16 实例、数据库 `visionowl` 和最小权限账号 `visionowl_app`。使用内网连接地址，不申请公网地址。RDS 白名单只加入 ECS 私网 IP，或绑定只包含该 ECS 的安全组。

阿里云官方说明：同 VPC 的 ECS 应使用 RDS 内网地址，并将 ECS 私网 IP 加入白名单，见 [RDS PostgreSQL 连接与网络](https://help.aliyun.com/en/rds/apsaradb-rds-for-postgresql/connections-and-networks/) 和 [设置 IP 白名单](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/configure-an-ip-address-whitelist-for-an-apsaradb-rds-for-postgresql-instance-1)。

### 3.3 域名与 HTTPS

正式环境优先准备域名，例如 `visionowl.example.com`。推荐使用 ALB 的 HTTPS 监听绑定证书，再把请求转发到 ECS `8080`。证书配置参考 [ALB 管理证书](https://help.aliyun.com/zh/slb/application-load-balancer/manage-certificates)。

没有域名的联调环境也可以使用 Let's Encrypt 公网 IP 证书。IP 证书必须使用 shortlived profile，有效期约 6 天，需要 Certbot 5.4 或更高版本并配置自动续期。本次 ECS 使用该方式为 114.55.60.94 配置 HTTPS。

Cloud API 必须使用 HTTPS；Electron 只允许 `localhost` 和 `127.0.0.1` 使用明文 HTTP。

## 4. ECS 准备

1. SSH 登录 ECS。
2. 按阿里云官方文档安装 Docker CE、Buildx 和 Compose 插件。
3. 执行 `sudo systemctl enable --now docker`。
4. 执行 `docker compose version`，确认 Compose V2 可用。
5. 把 VisionOwl 仓库 Clone 到 `/opt/visionowl`，或通过 CI 将同一版本发布到该目录。
6. 执行 `cd /opt/visionowl`。

不要把本机 `data/`、`testRepo`、`.env`、DWS 身份、SSH 密钥或任何私有仓库上传到 ECS。

## 5. 先跑演示环境

该步骤用于验证镜像和接口，不用于正式数据。

1. 执行 `cd /opt/visionowl/infra`。
2. 执行 `cp .env.cloud.example .env.cloud`。
3. 把 `.env.cloud` 中的 PostgreSQL 密码替换为随机长密码。
4. 执行 `docker compose --env-file .env.cloud -f docker-compose.cloud.yml up -d --build`。
5. 执行 `docker compose --env-file .env.cloud -f docker-compose.cloud.yml ps`。
6. 在仓库根目录执行 `VISIONOWL_CLOUD_URL=http://127.0.0.1:8080 node infra/scripts/cloud-smoke-test.mjs`。

预期输出包含 `VisionOwl Cloud is healthy` 和 `store=postgres`。

排错时执行 `docker compose --env-file .env.cloud -f docker-compose.cloud.yml logs -f cloud gateway postgres`。

## 6. 切换正式 RDS

1. 执行 `cd /opt/visionowl/infra`。
2. 执行 `cp .env.rds.example .env.rds`。
3. 把 `DATABASE_URL` 改为 RDS 内网连接串。密码中的 `@`、`:`、`/` 等字符必须进行 URL 编码。
4. 保持 `PGSSL=true`，应用与迁移会统一执行严格证书校验；如果证书链不是系统可信链，把 RDS CA 以只读文件挂载到容器，并用 `PGSSL_CA_FILE` 填写容器内路径。
5. `VISIONOWL_ALLOWED_ORIGINS` 保留 Electron 本地渲染地址 `http://127.0.0.1:17300,http://localhost:17300`。开发期需要 Vite 时再加入 `http://127.0.0.1:4173,http://localhost:4173`。
6. 默认 `VISIONOWL_GATEWAY_BIND=127.0.0.1:8080`，适合由宿主 Nginx 反向代理；若 ALB 直接访问容器网关，才改成 `0.0.0.0:8080`，并将安全组来源限制为 ALB。
7. 执行 `docker compose --env-file .env.rds -f docker-compose.rds.yml up -d --build`。
8. Cloud 容器启动前会执行迁移；已记录在 `schema_migrations` 的版本会跳过。
9. 执行 `docker compose --env-file .env.rds -f docker-compose.rds.yml ps`，确认 `cloud` 为 healthy。
10. 执行 `curl http://127.0.0.1:8080/api/health`，确认返回 `status=ok`。

迁移账号正式上线时可拆成独立数据库账号：发布流程先用 DDL 账号运行 `npm run migrate:cloud`，应用容器只使用 DML 账号。当前 Compose 为第一阶段简化版本。

## 7. 接入 HTTPS

推荐链路为：Electron → HTTPS/WSS 域名 → ALB 443 → ECS Nginx 8080 → Cloud Backend 17800。

ALB 后端健康检查路径填写 `/api/health`。WebSocket 使用同一域名的 `/ws/` 路径，仓库内 Nginx 配置已设置 Upgrade 头和长连接超时。

HTTPS 完成后，在任意电脑执行 `curl https://visionowl.example.com/api/health`；本次实例执行 `curl https://114.55.60.94/api/health`。不要让客户端直接访问 ECS 的 `17800`。

本次 IP 证书由 `certbot/certbot:v5.4.0` 申请，证书位于 `/etc/letsencrypt/live/114.55.60.94/`。`visionowl-cert-renew.timer` 每 12 小时检查续期，成功后校验并重载 Nginx。可用 `systemctl status visionowl-cert-renew.timer` 检查定时器，用 `systemctl start visionowl-cert-renew.service` 手动验证一次。

## 8. Electron 使用流程

1. 每位成员在自己的电脑启动 `npm run desktop`；后续可以替换为签名安装包。
2. 点击顶部的“团队云端”。
3. 在登录页填写 Cloud API；本次实例填写 `https://114.55.60.94`。
4. 注册或登录。Electron 会把会话令牌交给系统安全存储加密，不写入仓库。
5. Owner 创建 Project。
6. Owner 回到本地分析面，分析授权仓库；随后在云端 Project 中点击“发布”，选择本地 Project。
7. 本地先调用 Graph Sanitizer，Cloud Backend 收到后再次校验，生成不可变 Graph Version；Owner 激活后，在线成员通过 WebSocket 自动刷新。
8. Owner 创建一次性 Editor 或 Viewer 邀请，协作者登录后兑换。

Editor 可以挂载文档和添加批注，Viewer 只读。只有 Owner 能发布、激活或回滚图谱、管理成员和撤销邀请。

## 9. 验收清单

- 未登录访问 Project API 返回 401。
- Viewer 能看图谱、文档和批注，但不能新增内容。
- Editor 能新增文档和批注，但不能发布图谱。
- Owner 能发布版本、激活旧版本、生成邀请、修改成员角色和移除成员。
- 邀请密钥只显示一次，数据库只保存哈希。
- 两台 Electron 同时打开同一 Project；一端新增批注，另一端无需刷新即可看到。
- 上传包含绝对路径、凭证形态文本、错误 Project ID、错误分支或断裂关系的图谱会被拒绝。
- ECS 上不存在本地源码仓库、SQLite、DWS 凭证和 Electron 会话文件。
- 公网只能访问 443，不能直接访问 17800 和 5432。
- 执行 `VISIONOWL_CLOUD_URL=https://114.55.60.94 node infra/scripts/cloud-collaboration-test.mjs`，注册、邀请兑换、图谱激活、Viewer 读取和 WebSocket 事件全部通过。

## 10. 更新与回滚

更新时：拉取指定 Git Commit，执行 `docker compose ... build cloud`，再执行 `docker compose ... up -d cloud gateway`。数据库迁移会先执行且只运行一次。

代码回滚时切回上一 Commit 并重新构建容器。图谱回滚不需要部署代码：Owner 在“图谱版本”中激活旧版本即可。

RDS 必须开启自动备份和删除保护。正式升级前创建快照；有破坏性 Schema 变更时必须提供独立回滚迁移，不能依赖代码回滚恢复数据库结构。

## 11. 当前边界

- 当前图谱上限为 5 MB，直接保存在 PostgreSQL JSONB 中；这一规模无需 OSS。
- 当单个图谱或版本量明显增长时，再把完整 JSON 写入 OSS，PostgreSQL 只保留 URI、Checksum 和检索摘要。
- Redis 不是当前闭环必需组件；多实例广播、异步文档任务和高频在线状态出现后再引入。
- 云端 AI Chat 与钉钉正文更新仍由本地受限 Agent 执行，Cloud Backend 不读取源码。
- Electron 签名、自动更新和安装包发布属于下一项发行工程，不影响本次云端协作 API 闭环。
