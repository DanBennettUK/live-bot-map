#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/public"
mkdir -p "$DEST"
for name in index.html list.html app.js styles.css config.js robots.txt; do
  cp "$ROOT/$name" "$DEST/$name"
done
echo "synced worker assets into public/"
