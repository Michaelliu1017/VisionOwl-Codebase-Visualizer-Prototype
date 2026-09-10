#!/bin/bash
# 在 ECS 上模拟 GitHub push webhook,验证 Receiver 全链路。
# secret 从 /opt/vo/infra/.env 读取,不经外部传输。
set -uo pipefail

BASE=http://127.0.0.1:8080
SECRET=$(grep '^GITHUB_WEBHOOK_SECRET=' /opt/vo/infra/.env | cut -d= -f2-)
REPO="Michaelliu1017/vit-boardgame-analyzer"

# 取该仓库当前真实 HEAD,让增量分析有真实 SHA 可用
HEAD_SHA=$(git -C /root/vit-boardgame-analyzer rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000")
BEFORE_SHA=$(git -C /root/vit-boardgame-analyzer rev-parse HEAD~1 2>/dev/null || echo "1111111111111111111111111111111111111111")
echo "仓库 HEAD=$HEAD_SHA"
echo

post() {                       # post <event> <delivery> <body> [bad-sig]
  local event="$1" delivery="$2" body="$3" bad="${4:-}"
  local sig
  if [ -n "$bad" ]; then
    sig="sha256=deadbeef"
  else
    sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
  fi
  curl -s -o /tmp/wh-resp.json -w '%{http_code}' -X POST "$BASE/webhook/github" \
    -H 'Content-Type: application/json' \
    -H "X-GitHub-Event: $event" \
    -H "X-GitHub-Delivery: $delivery" \
    -H "X-Hub-Signature-256: $sig" \
    --data-binary "$body"
}

mkbody() {                     # mkbody <ref>
  cat <<EOF
{"ref":"$1","before":"$BEFORE_SHA","after":"$HEAD_SHA","deleted":false,
 "repository":{"full_name":"$REPO","default_branch":"main"},
 "head_commit":{"id":"$HEAD_SHA","message":"simulated push"},
 "pusher":{"name":"tester"}}
EOF
}

line() { printf '%-46s ' "$1"; }

echo "───────── 负例:安全性必须先成立 ─────────"
line "① 错误签名(应 403 拒绝)"
code=$(post push "d-badsig-$RANDOM" "$(mkbody refs/heads/main)" bad)
echo "HTTP $code  $(head -c 90 /tmp/wh-resp.json)"

line "② 无签名头(应 403)"
body=$(mkbody refs/heads/main)
code=$(curl -s -o /tmp/wh-resp.json -w '%{http_code}' -X POST "$BASE/webhook/github" \
  -H 'Content-Type: application/json' -H 'X-GitHub-Event: push' \
  -H "X-GitHub-Delivery: d-nosig-$RANDOM" --data-binary "$body")
echo "HTTP $code  $(head -c 90 /tmp/wh-resp.json)"

echo
echo "───────── 正例与过滤 ─────────"
line "③ ping 事件(GitHub 配置自检)"
code=$(post ping "d-ping-$RANDOM" '{"zen":"Keep it logically awesome."}')
echo "HTTP $code  $(cat /tmp/wh-resp.json)"

line "④ 非 push 事件(应被忽略)"
code=$(post issues "d-iss-$RANDOM" '{"action":"opened"}')
echo "HTTP $code  $(cat /tmp/wh-resp.json)"

line "⑤ 非目标分支 dev(应无绑定匹配)"
code=$(post push "d-dev-$RANDOM" "$(mkbody refs/heads/dev)")
echo "HTTP $code  $(cat /tmp/wh-resp.json)"

echo
echo "───────── 主链路:main 分支推送 ─────────"
DELIV="d-main-$RANDOM"
line "⑥ 首次投递(应创建任务)"
code=$(post push "$DELIV" "$(mkbody refs/heads/main)")
echo "HTTP $code"
python3 -m json.tool /tmp/wh-resp.json 2>/dev/null | head -14

line "⑦ 同一 delivery 重放(幂等,应 duplicate)"
code=$(post push "$DELIV" "$(mkbody refs/heads/main)")
echo "HTTP $code  $(cat /tmp/wh-resp.json)"
