#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd -P)"
DETERMINISTIC="false"

usage() {
  printf '%s\n' "Usage: start-local.sh [--deterministic]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deterministic)
      DETERMINISTIC="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done
if [[ ! -d "${PROJECT_ROOT}/node_modules" ]]; then
  printf '%s\n' "Dependencies are missing. Run npm ci from ${PROJECT_ROOT} first." >&2
  exit 1
fi
if ! node "${SCRIPT_DIR}/check-port.mjs" 17300; then
  printf '%s\n' "Port 17300 is already occupied. Close the existing VisionOwl instance first." >&2
  exit 1
fi
CLOUD_PID=""

cleanup() {
  if [[ -n "${CLOUD_PID}" ]] && kill -0 "${CLOUD_PID}" 2>/dev/null; then
    kill "${CLOUD_PID}" 2>/dev/null || true
    wait "${CLOUD_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if node "${SCRIPT_DIR}/wait-for-cloud.mjs" "http://127.0.0.1:17800/api/health" 600 >/dev/null 2>&1; then
  printf '%s\n' "Reusing the healthy VisionOwl Cloud Backend on port 17800."
else
  if ! node "${SCRIPT_DIR}/check-port.mjs" 17800; then
    printf '%s\n' "Port 17800 is occupied by a non-VisionOwl service." >&2
    exit 1
  fi
  printf '%s\n' "Starting the memory-backed VisionOwl Cloud Backend..."
  (
    cd "${PROJECT_ROOT}"
    VISIONOWL_CLOUD_STORE=memory HOST=127.0.0.1 PORT=17800 \
      node cloud-backend/src/server.js
  ) &
  CLOUD_PID=$!
  node "${SCRIPT_DIR}/wait-for-cloud.mjs" "http://127.0.0.1:17800/api/health" 12000
fi

printf '%s\n' "Starting VisionOwl Electron..."

cd "${PROJECT_ROOT}"
if [[ "${DETERMINISTIC}" == "true" ]]; then
  VISIONOWL_CLOUD_API_URL=http://127.0.0.1:17800 \
  VISIONOWL_CODEX_ENABLED=false \
    npm run desktop
else
  VISIONOWL_CLOUD_API_URL=http://127.0.0.1:17800 \
    npm run desktop
fi
