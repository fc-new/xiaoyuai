#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Please install Node.js 24 LTS first."); process.exit(1); }'
if [ ! -d node_modules ]; then
  npm ci --cache /tmp/xiaoyuai-npm-cache --no-audit --no-fund
fi
npm run setup
exec npm run dev
