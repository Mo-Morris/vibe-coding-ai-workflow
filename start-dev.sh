#!/usr/bin/env bash
# 一键启动后端（FastAPI）与前端（Vite）；按 Ctrl+C 会一同停止。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BACKEND_HOST="${VCAW_BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${VCAW_BACKEND_PORT:-8000}"

if [[ -x "$ROOT/backend/.venv/bin/python" ]]; then
  PY="$ROOT/backend/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
else
  echo "error: 需要 python3，或先在 backend 下创建 .venv" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: 需要 npm（请安装 Node.js）" >&2
  exit 1
fi

BACKEND_PID=""
FRONTEND_PID=""

kill_children() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]]; then
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$FRONTEND_PID" ]]; then
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi
}

trap 'kill_children; exit 130' INT
trap 'kill_children; exit 143' TERM
trap 'kill_children' EXIT

(
  cd "$ROOT/backend"
  exec "$PY" -m uvicorn app.main:app --reload --host "$BACKEND_HOST" --port "$BACKEND_PORT"
) &
BACKEND_PID=$!

(
  cd "$ROOT/frontend"
  export VITE_API_BASE="${VITE_API_BASE:-http://${BACKEND_HOST}:${BACKEND_PORT}}"
  exec npm run dev
) &
FRONTEND_PID=$!

echo "后端: http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "前端: http://127.0.0.1:5173"
echo "按 Ctrl+C 停止前后端"
echo

# 任一进程退出时结束另一个（避免多个 wait 争抢同一 PID）
set +e
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 0.3
done
set -e
kill_children
wait "$BACKEND_PID" 2>/dev/null || true
wait "$FRONTEND_PID" 2>/dev/null || true
