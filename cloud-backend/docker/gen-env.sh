#!/bin/bash
# 在 ECS 上生成 /opt/vo/infra/.env:凭证本机随机生成,不经外部传输
set -euo pipefail

ENV_FILE=/opt/vo/infra/.env
if [ -f "$ENV_FILE" ]; then
  echo "已存在 $ENV_FILE,跳过生成(如需重建请先手动备份删除)"
  exit 0
fi

PG_PASS=$(openssl rand -hex 24)
JWT=$(openssl rand -hex 32)

umask 077
cat > "$ENV_FILE" <<EOF
# 由 gen-env.sh 于 $(date -Iseconds) 生成;权限 600,禁止入库
NODE_ENV=production
PORT=17800
LOG_LEVEL=info
PUBLIC_BASE_URL=http://114.55.60.94:8080
CORS_ORIGIN=*

# —— 新库 visionowl_v2:与旧栈 visionowl 库隔离,避免表结构污染 ——
POSTGRES_DB=visionowl_v2
POSTGRES_USER=visionowl
POSTGRES_PASSWORD=${PG_PASS}
DATABASE_URL=postgres://visionowl:${PG_PASS}@postgres:5432/visionowl_v2
REDIS_URL=redis://redis:6379
ARTIFACTS_DIR=/data/artifacts

JWT_SECRET=${JWT}
JWT_TTL_DAYS=7
LOGIN_RATE_MAX=5
LOGIN_RATE_WINDOW=1 minute
CHAT_RATE_MAX=20
CHAT_RATE_WINDOW=1 minute

JOB_DEBOUNCE_SECONDS=30
WORKER_CONCURRENCY=3
JOB_TIMEOUT_FULL=1200
JOB_TIMEOUT_INCREMENTAL=600

# 冒烟阶段用 demo(零依赖);跑真实扫描改 local
ANALYZER_MODE=demo
RUNNER_IMAGE=visionowl-runner:latest
RUNNER_NETWORK=runner-net
WORKSPACE_DIR=/data/workspace
MAX_TURNS_FULL=50
MAX_TURNS_INCREMENTAL=25

# 网关对外绑定(桌面端联调需要外网可达)
VISIONOWL_GATEWAY_BIND=0.0.0.0:8080

# P2 起用,留空不影响 MVP
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY_PATH=
GITHUB_WEBHOOK_SECRET=
QODER_PERSONAL_ACCESS_TOKEN=
OSS_BUCKET=
OSS_ENDPOINT=
EOF

chmod 600 "$ENV_FILE"
echo "✅ 已生成 $ENV_FILE (权限 $(stat -c %a "$ENV_FILE"))"
echo "   库名: visionowl_v2  |  PG 密码与 JWT 密钥已随机生成(未回显)"
