# 并入 ECS 现有 infra 栈

> ECS 现状（spec §6.2）：compose 项目名 `infra`，已有
> `infra-gateway-1`(nginx:1.27-alpine, 当前只绑 127.0.0.1:8080) → `infra-cloud-1`(:17800) → `infra-postgres-1`(卷 `infra_visionowl-postgres`)。
>
> **本服务就是 `infra-cloud` 的正式实现**——替换其镜像内容，不要另起一套栈。

## 需要的三处基础设施变更

1. 新增 `redis:7-alpine`（内网，不暴露公网端口）
2. gateway 发布改 `0.0.0.0:8080`（桌面端要从外网访问；放开前确认登录限速已生效——本服务已内置 5 次/分/IP）
3. 挂载 `/data/artifacts` 进 cloud 与 worker 容器

**红线**：不得关闭/重建 `infra-postgres-1` 的数据卷；改 compose 前先 `docker compose config` 校验。

## compose 片段（合并进现有 compose.yaml）

```yaml
services:
  gateway:
    image: registry.cn-hangzhou.aliyuncs.com/library/nginx:1.27-alpine
    ports:
      - "0.0.0.0:8080:80"          # ← 由 127.0.0.1:8080 改为 0.0.0.0
    depends_on: [cloud]
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro

  cloud:
    build:
      context: ./cloud-backend
      dockerfile: docker/Dockerfile
    image: visionowl-cloud:latest
    env_file: [./cloud-backend/.env]
    environment:
      PORT: "17800"
      DATABASE_URL: postgres://visionowl:***@postgres:5432/visionowl
      REDIS_URL: redis://redis:6379
      ARTIFACTS_DIR: /data/artifacts
    volumes:
      - /data/artifacts:/data/artifacts        # ← 新增
    depends_on: [postgres, redis]
    restart: unless-stopped

  worker:                                      # ← 新增：同镜像不同入口
    image: visionowl-cloud:latest
    command: ["node", "dist/worker/index.js"]
    env_file: [./cloud-backend/.env]
    environment:
      DATABASE_URL: postgres://visionowl:***@postgres:5432/visionowl
      REDIS_URL: redis://redis:6379
      ARTIFACTS_DIR: /data/artifacts
      WORKSPACE_DIR: /data/workspace
      ANALYZER_MODE: local                     # demo | local | runner
      WORKER_CONCURRENCY: "3"
    volumes:
      - /data/artifacts:/data/artifacts
      - /data/workspace:/data/workspace
    depends_on: [postgres, redis]
    restart: unless-stopped

  redis:                                       # ← 新增
    image: registry.cn-hangzhou.aliyuncs.com/library/redis:7-alpine
    command: ["redis-server", "--appendonly", "no", "--save", ""]
    restart: unless-stopped
    # 不暴露端口，仅栈内网可达

  postgres:
    image: registry.cn-hangzhou.aliyuncs.com/library/postgres:16-alpine
    # ⚠ 保持原有 environment 与卷不动
    volumes:
      - visionowl-postgres:/var/lib/postgresql/data

volumes:
  visionowl-postgres:
    external: false     # ⚠ 已存在的卷名 infra_visionowl-postgres，不要改名
```

## nginx 关键配置（SSE 必须关闭缓冲）

```nginx
server {
  listen 80;
  client_max_body_size 4m;

  location / {
    proxy_pass http://cloud:17800;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE：/events 与 /chat 是长连接流，必须关缓冲并放长超时
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    chunked_transfer_encoding on;
  }
}
```

> 后端已对 SSE 响应加 `X-Accel-Buffering: no`，即使漏配 `proxy_buffering off` 也能生效；两者都配最稳。

## ANALYZER_MODE 选择

| 模式 | 依赖 | 用途 |
|---|---|---|
| `demo` | 无 | 冒烟：不克隆仓库，复用 seed 演示图谱，验证队列→版本→SSE 全链路 |
| `local` | git | 真实确定性扫描（零 credit），无需 ACR / qodercli；可用 `LOCAL_REPO_PATH` 直接分析宿主机目录 |
| `runner` | ACR + Docker socket + qodercli PAT | 完整两段式（扫描 + Agent 语义增强） |

`runner` 模式下 worker 需要能调 Docker：

```yaml
  worker:
    environment:
      ANALYZER_MODE: runner
      RUNNER_IMAGE: visionowl-runner:latest
      RUNNER_NETWORK: runner-net
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # 需要 docker CLI，见下
```

镜像内需有 docker 客户端，两种做法任选：
1. 在 `docker/Dockerfile` 的运行阶段加 `apt-get install -y docker.io`（走 ACR 的 apt 源）；
2. 或把 worker 作为宿主机进程跑（`node dist/worker/index.js`，用 systemd 守护），宿主机已装 docker 26.1.3。

Runner 出网白名单网络（spec §7.3）：

```bash
docker network create --internal=false runner-net
# 仅放行 github.com / qoder.com / OSS 内网 endpoint / 构建期 npm
# 具体规则用 iptables 或安全组落实，禁止 Runner 访问 ECS 内网其它服务
```
