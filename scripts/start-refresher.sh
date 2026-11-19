#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

ENV_FILE="${LBM_ENV_FILE:-$REPO_DIR/.secrets/refresher.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

DIR="${LBM_ROOT:-$REPO_DIR}"
mkdir -p "$DIR/logs"
if [ -f "$DIR/logs/refresher.pid" ]; then
  old=$(cat "$DIR/logs/refresher.pid" || true)
  if [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; then
    echo "refresher already running as pid $old"
    exit 0
  fi
fi
cd "$DIR"
setsid nohup env PYTHONUNBUFFERED=1 python3 "$DIR/scripts/refresh.py" --loop >> "$DIR/logs/refresher.log" 2>&1 < /dev/null &
echo $! > "$DIR/logs/refresher.pid"
echo "started refresher pid $!"
