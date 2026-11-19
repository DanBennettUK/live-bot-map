#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/public"
rm -rf "$DEST"
mkdir -p "$DEST"
for name in index.html list.html app.js styles.css config.js robots.txt; do
  cp "$ROOT/$name" "$DEST/$name"
done
if [ -f "$ROOT/_headers" ]; then
  cp "$ROOT/_headers" "$DEST/_headers"
fi
cat > "$DEST/.assetsignore" <<'EOF'
.assetsignore
_headers
*
!index.html
!list.html
!app.js
!styles.css
!config.js
!robots.txt
EOF
echo "synced worker assets into public/"
