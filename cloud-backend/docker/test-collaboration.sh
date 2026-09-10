#!/bin/bash
# VisionOwl collaboration smoke test: owner invite, editor redeem, shared access.
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@demo.dev}"
OWNER_PASSWORD="${OWNER_PASSWORD:-demo1234}"
EDITOR_EMAIL="${EDITOR_EMAIL:-editor@demo.dev}"
EDITOR_PASSWORD="${EDITOR_PASSWORD:-demo1234}"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

json_field() {
  python3 -c "import json,sys; print(json.load(sys.stdin)$1)"
}

login() {
  local email="$1" password="$2"
  curl -fsS -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
    | json_field '["token"]'
}

OWNER_TOKEN=$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")
EDITOR_TOKEN=$(login "$EDITOR_EMAIL" "$EDITOR_PASSWORD")

PROJECT_ID="${PROJECT_ID:-$(curl -fsS "$BASE/api/projects" \
  -H "Authorization: Bearer $OWNER_TOKEN" | json_field '["items"][0]["id"]')}"

owner_status=$(curl -sS -o "$tmpdir/invite.json" -w '%{http_code}' -X POST \
  "$BASE/api/projects/$PROJECT_ID/invitations" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}')
test "$owner_status" = "201"

INVITATION_ID=$(json_field '["id"]' < "$tmpdir/invite.json")
INVITATION_KEY=$(json_field '["key"]' < "$tmpdir/invite.json")
MAX_USES=$(json_field '["maxUses"]' < "$tmpdir/invite.json")
EXPIRES_AT=$(json_field '["expiresAt"]' < "$tmpdir/invite.json")
test "$MAX_USES" = "None"
test "$EXPIRES_AT" = "None"
echo "PASS owner generated a permanent, unlimited invitation"

redeem_status=$(curl -sS -o "$tmpdir/redeem.json" -w '%{http_code}' -X POST \
  "$BASE/api/invitations/redeem" \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"key\":\"$INVITATION_KEY\"}")
test "$redeem_status" = "200"
echo "PASS editor redeemed the invitation"

editor_invite_status=$(curl -sS -o "$tmpdir/editor-invite.json" -w '%{http_code}' -X POST \
  "$BASE/api/projects/$PROJECT_ID/invitations" \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}')
test "$editor_invite_status" = "403"
echo "PASS editor cannot generate invitations"

shared_project_status=$(curl -sS -o "$tmpdir/project.json" -w '%{http_code}' \
  "$BASE/api/projects/$PROJECT_ID" \
  -H "Authorization: Bearer $EDITOR_TOKEN")
test "$shared_project_status" = "200"
test "$(json_field '["id"]' < "$tmpdir/project.json")" = "$PROJECT_ID"
echo "PASS editor can read the shared project"

revoke_status=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
  "$BASE/api/projects/$PROJECT_ID/invitations/$INVITATION_ID" \
  -H "Authorization: Bearer $OWNER_TOKEN")
test "$revoke_status" = "204"
echo "PASS test invitation revoked"

echo "VisionOwl collaboration smoke test passed"
