#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
RUNTIME_NODE="$PROJECT_ROOT/node_modules/.bin/node"
if [ ! -x "$RUNTIME_NODE" ]; then RUNTIME_NODE="node"; fi
printf '财小智 SRS 本地 Demo\n浏览器地址：http://127.0.0.1:5187/srs-review.html\n关闭窗口或按 Ctrl+C 停止服务。\n\n'
exec "$RUNTIME_NODE" apps/web/node_modules/vite/bin/vite.js --config apps/web/vite.srs-review.config.ts
